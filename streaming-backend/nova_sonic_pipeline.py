"""方案 B — Nova Sonic pipeline (end-to-end speech-to-speech).

Unlike the Transcribe pipeline (ASR→LLM→TTS), Nova Sonic is ONE bidirectional
Bedrock stream: 16 kHz PCM in, 24 kHz PCM out + transcripts + tool-use. No
separate stages, so the UI shows E2E (user recognized → first response audio),
not an ASR/LLM/TTS split. Nova Sonic does its own turn-taking/endpointing, so
there is no VAD/aggregation here. Reuses chatbot-demo's proven protocol (nova/).
"""
from __future__ import annotations

import asyncio
import os

import tools
from nova.config import MODEL_ID, BedrockOpenError
from nova.events import AudioOutEvent, TranscriptEvent
from nova.session import SonicSession
from timings import TurnTiming, now_ms

REGION = os.environ.get("AWS_REGION", "us-west-2")
OUT_RATE = 24000  # Nova Sonic audio output rate

SYSTEM_PROMPT = (
    "You are a friendly bilingual (English and Mandarin) voice assistant. Reply in the "
    "same language the caller used. You can tell the time (get_current_time) and give a "
    "short weather report (get_weather); call a tool for those and report what it returns. "
    "Keep replies to one short spoken sentence. Use plain spoken words only — no emoji or "
    "symbols. Politely decline anything unrelated."
)


def _log(m):
    print(f"[nova] {m}", flush=True)


class _Registry:
    """Duck-typed ToolRegistry — SonicSession only needs to_bedrock_config().

    Nova Sonic's promptStart.toolConfiguration requires inputSchema.json to be a
    JSON *string* (json.dumps), unlike Bedrock Converse (which takes a dict). Our
    shared tools.TOOL_CONFIG is Converse-shaped (dict), so stringify it here —
    otherwise Nova rejects promptStart with "Unable to parse input chunk".
    """
    def to_bedrock_config(self):
        import copy
        import json as _json
        cfg = copy.deepcopy(tools.TOOL_CONFIG)
        for t in cfg.get("tools", []):
            schema = t.get("toolSpec", {}).get("inputSchema", {}).get("json")
            if isinstance(schema, dict):
                t["toolSpec"]["inputSchema"]["json"] = _json.dumps(schema)
        return cfg


class _Dispatcher:
    """Duck-typed ToolDispatcher — SonicSession needs async dispatch(id, name, args)."""
    async def dispatch(self, tool_use_id, tool_name, arguments):
        _log(f"tool: {tool_name}({arguments})")
        return tools.dispatch(tool_name, arguments)


class _Logger:
    def __getattr__(self, _name):
        return lambda *a, **k: None


class NovaSonicPipeline:
    def __init__(self, session_id, language, send_audio, send_json):
        self.session_id = session_id
        self.language = language
        self.send_audio = send_audio
        self.send_json = send_json
        self._session = SonicSession(
            REGION, _Registry(), _Logger(), _Dispatcher(), system_prompt=SYSTEM_PROMPT,
        )
        self._consumer = None
        self._turn_seq = 0
        self.turn = None
        self._first_audio_frame = False

    def _new_turn(self):
        self._turn_seq += 1
        self.turn = TurnTiming(self.session_id, f"t{self._turn_seq}", "nova-sonic", model=MODEL_ID)
        self._first_audio_frame = False

    async def start(self):
        _log(f"opening Nova Sonic stream (model={MODEL_ID})")
        try:
            await self._session.open()
        except BedrockOpenError as e:
            _log(f"open ERROR: {e.category}: {e.detail}")
            await self.send_json({"type": "error", "message": f"Nova Sonic open failed: {e.category}"})
            raise
        self._new_turn()
        self._consumer = asyncio.create_task(self._consume())
        self._consumer.add_done_callback(self._on_consumer_done)
        await self.send_json({"type": "audio_format", "rate": OUT_RATE})
        await self.send_json({"type": "status", "state": "active"})
        _log("stream open")

    def _on_consumer_done(self, task):
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc:
            _log(f"consumer ERROR: {type(exc).__name__}: {exc}")

    async def feed_audio(self, pcm: bytes):
        if self.turn and not self._first_audio_frame:
            self.turn.t_recv = now_ms()
            self._first_audio_frame = True
        try:
            await self._session.send_audio(pcm)
        except Exception as e:
            _log(f"send_audio ERROR: {type(e).__name__}: {e}")

    async def _consume(self):
        # A "turn" = one USER utterance -> the assistant's response. Nova streams
        # many audio chunks per response, so we DON'T start a new turn per chunk —
        # we start one when a new USER transcript arrives (after the prior turn was
        # answered), and emit timing once, on that turn's first audio-out.
        async for ev in self._session.stream_events():
            if isinstance(ev, AudioOutEvent):
                if self.turn and self.turn.t_asr_final and self.turn.t_first_audio_out is None:
                    self.turn.t_first_audio_out = now_ms()
                    await self._emit_timing()
                await self.send_audio(ev.pcm)
            elif isinstance(ev, TranscriptEvent):
                if ev.role == "USER":
                    # New user utterance -> new turn (once the previous got a reply).
                    if self.turn is None or self.turn.t_first_audio_out is not None:
                        self._new_turn()
                    self.turn.t_asr_final = now_ms()
                    self.turn.text_user = ev.text
                    _log(f"USER: {ev.text!r}")
                    await self.send_json({"type": "transcript", "who": "CUSTOMER", "text": ev.text})
                else:  # ASSISTANT
                    if self.turn:
                        self.turn.text_bot = (self.turn.text_bot or "") + ev.text
                    _log(f"BOT: {ev.text!r}")
                    await self.send_json({"type": "transcript", "who": "BOT", "text": ev.text})

    async def _emit_timing(self):
        turn = self.turn
        # S2S has no stage split; report user-recognized -> first response audio.
        e2e = (turn.t_first_audio_out - turn.t_asr_final) if (turn.t_asr_final and turn.t_first_audio_out) else None
        turn.persist()
        await self.send_json({"type": "timing", "turnId": turn.turn_id, "pipeline": "nova-sonic",
                              "asr": None, "llm": None, "tts": None, "e2e": e2e})
        _log(f"turn {turn.turn_id} e2e={e2e}ms")

    async def stop(self):
        try:
            await self._session.close()
        except Exception:
            pass
        if self._consumer:
            self._consumer.cancel()
