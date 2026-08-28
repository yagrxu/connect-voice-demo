"""方案 B — Transcribe + Bedrock + Polly, fully streaming, with precise per-stage
timestamps. Runs as an AgentCore Runtime agent (one instance per WS session).

    browser 16k PCM ─▶ Transcribe streaming ─▶ (on final) Bedrock Converse stream
                                                    │ tool loop (get_time/weather)
                                                    ▼
                        browser ◀─ 16k PCM ◀─ Polly streaming (first-byte timed)

Each turn writes a TurnTiming row (timings.py) and pushes a `timing` WS message
so the browser latency panel shows a PRECISE ASR/LLM/TTS split.

Deployed + verified (docs/latency-optimization-plan.md, 方案 B). Endpointing is
server-side VAD (finalize on latest partial after SILENCE_MS of quiet) to beat
Transcribe's slower built-in finalization.
"""
from __future__ import annotations

import asyncio
import os

import boto3
import webrtcvad
from amazon_transcribe.client import TranscribeStreamingClient
from amazon_transcribe.handlers import TranscriptResultStreamHandler
from amazon_transcribe.model import TranscriptEvent

import tools
from timings import TurnTiming, now_ms

def _log(m):
    print(f"[pipe] {m}", flush=True)


REGION = os.environ.get("AWS_REGION", "us-west-2")
LLM_MODEL = os.environ.get("LLM_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
OUT_RATE = 16000  # Polly PCM max; client is told this via an audio_format message
# Turn-taking: aggregate all of Transcribe's segments for one utterance and end
# the turn only after Transcribe STOPS emitting new transcripts for SILENCE_MS.
# Using Transcribe's own speech detection (not an audio-level threshold) means a
# quiet mic that Transcribe still hears is NOT mistaken for silence. Mid-sentence
# pauses keep the turn open as long as Transcribe resumes within SILENCE_MS.
# End-of-turn = the AUDIO went silent, detected by a real VAD (webrtcvad, which
# classifies voiced speech vs non-speech — not a loudness threshold, so softly
# spoken words like an unstressed "Tokyo" are still "speech" and don't trip a
# false endpoint). We end the turn only when BOTH the audio has been non-speech
# for VAD_SILENCE_MS AND Transcribe has stopped updating for SETTLE_MS.
VAD_MODE = 1            # webrtcvad aggressiveness 0..3 (lower = more sensitive to speech)
VAD_FRAME_BYTES = 640   # 20ms @ 16kHz mono 16-bit (webrtcvad needs 10/20/30ms frames)
VAD_SILENCE_MS = 500    # non-speech this long = user stopped talking
SETTLE_MS = 500         # AND Transcribe stopped updating (caught up); 500 is the floor
                        # — 400 truncated the last word ("Seat"/"Seattle").
STALE_MS = 6000         # fallback: discard a turn if nothing transcribes for this long

# Kept in sync with the Connect prompt (docs/latency-optimization-plan.md, A4):
# same-language reply, must call a tool, natural spoken time, one short sentence.
SYSTEM_PROMPT = (
    "You are a friendly bilingual (English and Mandarin) voice assistant. Reply in the "
    "SAME language the caller used. You can tell the time (get_current_time) and give a "
    "short weather report (get_weather); you MUST call a tool for those and report only "
    "what it returns. Speak times in natural spoken form, never ISO. Keep replies to one "
    "short spoken sentence. Do not announce or narrate tool use (no 'let me check'); "
    "reply only with the final answer after the tool returns. Use plain spoken words only "
    "— no emoji, symbols, markdown, or code. Politely decline anything unrelated."
)

_LOCALE = {"en_US": ("en-US", "Matthew"), "zh_CN": ("zh-CN", "Zhiyu")}


class _Handler(TranscriptResultStreamHandler):
    """Bridges Transcribe output events back to the pipeline."""

    def __init__(self, output_stream, pipeline: "TranscribePipeline"):
        super().__init__(output_stream)
        self.p = pipeline

    async def handle_transcript_event(self, event: TranscriptEvent):
        for result in event.transcript.results:
            if not result.alternatives:
                continue
            text = result.alternatives[0].transcript
            # Transcribe emitting words == the user is speaking (mic-level
            # independent). We bump _last_transcript_ms and end the turn only
            # after transcripts STOP for SILENCE_MS. Aggregate segments; a mid-
            # sentence pause keeps the turn open as long as Transcribe resumes.
            self.p._last_transcript_ms = now_ms()
            if self.p.turn.t_asr_first_partial is None:
                self.p.turn.t_asr_first_partial = self.p._last_transcript_ms
                _log(f"ASR first partial: {text!r}")
            if result.is_partial:
                self.p._latest_partial = text
            else:
                self.p._final_segments.append(text)
                self.p._latest_partial = ""


class TranscribePipeline:
    def __init__(self, session_id: str, language: str, send_audio, send_json):
        self.session_id = session_id
        self.language = language if language in _LOCALE else "en_US"
        self.send_audio = send_audio    # async (bytes) -> None  (24k/16k PCM to browser)
        self.send_json = send_json      # async (dict) -> None
        self._transcribe = TranscribeStreamingClient(region=REGION)
        self._bedrock = boto3.client("bedrock-runtime", region_name=REGION)
        self._polly = boto3.client("polly", region_name=REGION)
        self._vad = webrtcvad.Vad(VAD_MODE)
        self._vad_buf = bytearray()  # accumulates PCM, sliced into 20ms VAD frames
        self._stream = None
        self._handler_task = None
        self._watch_task = None
        self._closed = False
        self._turn_seq = 0
        self.turn: TurnTiming | None = None
        self._first_audio_frame_seen = False
        # Endpointing (energy VAD) + segment aggregation state (reset in _new_turn)
        self._last_transcript_ms = 0
        self._latest_partial = ""
        self._final_segments = []
        self._finalized = False
        self._speech_seen = False
        self._last_speech_ms = 0

    async def start(self):
        lang_code, _ = _LOCALE[self.language]
        _log(f"start: lang={lang_code} model={LLM_MODEL}")
        # VERIFY: start_stream_transcription kwargs / attribute names.
        self._stream = await self._transcribe.start_stream_transcription(
            language_code=lang_code,
            media_sample_rate_hz=16000,
            media_encoding="pcm",
        )
        _log("transcribe stream opened")
        self._new_turn()
        handler = _Handler(self._stream.output_stream, self)
        self._handler_task = asyncio.create_task(handler.handle_events())
        self._handler_task.add_done_callback(self._on_handler_done)
        self._watch_task = asyncio.create_task(self._watch_endpoint())
        await self.send_json({"type": "audio_format", "rate": OUT_RATE})
        await self.send_json({"type": "status", "state": "active"})

    def _on_handler_done(self, task):
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc:
            _log(f"handler task ERROR: {type(exc).__name__}: {exc}")

    def _new_turn(self):
        self._turn_seq += 1
        self.turn = TurnTiming(self.session_id, f"t{self._turn_seq}", "transcribe", model=LLM_MODEL)
        self._first_audio_frame_seen = False
        self._last_transcript_ms = 0
        self._latest_partial = ""
        self._final_segments = []
        self._finalized = False
        self._speech_seen = False   # energy VAD saw speech this turn
        self._last_speech_ms = 0    # last time audio energy was above SPEECH_RMS

    async def feed_audio(self, pcm: bytes):
        """16 kHz mono Int16 PCM frame from the browser."""
        if self.turn and not self._first_audio_frame_seen:
            self.turn.t_recv = now_ms()
            self._first_audio_frame_seen = True
            _log(f"first audio frame ({len(pcm)} bytes)")
        if not self._stream:
            return
        try:
            await self._stream.input_stream.send_audio_event(audio_chunk=pcm)
        except Exception as e:
            _log(f"send_audio ERROR: {type(e).__name__}: {e}")
            return
        # webrtcvad speech detection: slice the stream into 20ms frames and mark
        # the last time any frame was classified as speech (voiced) — robust to
        # softly spoken words, unlike a loudness threshold.
        self._vad_buf.extend(pcm)
        while len(self._vad_buf) >= VAD_FRAME_BYTES:
            frame = bytes(self._vad_buf[:VAD_FRAME_BYTES])
            del self._vad_buf[:VAD_FRAME_BYTES]
            try:
                if self._vad.is_speech(frame, 16000):
                    self._speech_seen = True
                    self._last_speech_ms = now_ms()
            except Exception:
                pass

    async def _watch_endpoint(self):
        """End the turn once the AUDIO has been silent for VAD_SILENCE_MS after
        speech — detects when the user actually stopped, independent of how
        bursty Transcribe's partial emission is. Own timer, not frame-tied."""
        while not self._closed:
            await asyncio.sleep(0.15)
            if self._finalized or not self._speech_seen:
                continue
            now = now_ms()
            quiet = now - self._last_speech_ms          # audio silent this long
            settled = now - self._last_transcript_ms    # Transcribe idle this long
            # End only when BOTH: the user stopped talking (audio quiet) AND
            # Transcribe caught up (no recent transcript update). The audio-quiet
            # check prevents Transcribe's mid-utterance emission bursts from
            # splitting; the settled check prevents grabbing a lagging, truncated
            # partial before Transcribe finishes the last word.
            if quiet <= VAD_SILENCE_MS:
                continue
            parts = self._final_segments + ([self._latest_partial] if self._latest_partial else [])
            full = " ".join(parts).strip()
            if full and self._last_transcript_ms and settled > SETTLE_MS:
                _log(f"turn end (audio quiet {quiet}ms, transcript settled {settled}ms): {full!r}")
                await self._finalize(full, "vad")
            elif not self._last_transcript_ms and quiet > STALE_MS:
                _log("discarding turn: speech energy but no transcript")
                self._speech_seen = False

    async def _finalize(self, text: str, via: str):
        """End the current utterance (from Transcribe's final OR VAD), once."""
        if self._finalized or self.turn is None or not text:
            return
        self._finalized = True
        turn = self.turn
        # End of actual speech = last VAD speech frame. Anchoring timings here
        # (not at speech onset) keeps a long utterance from inflating the numbers.
        if self._last_speech_ms:
            turn.t_speech_end = self._last_speech_ms
        if turn.t_asr_final is None:
            turn.t_asr_final = now_ms()
        turn.text_user = text
        _log(f"ASR final via {via}: {text!r}")
        await self.send_json({"type": "transcript", "who": "CUSTOMER", "text": text})
        try:
            await self._respond(turn, text)
        except Exception as e:
            _log(f"respond ERROR: {type(e).__name__}: {e}")
            await self.send_json({"type": "error", "message": str(e)})
        self._new_turn()  # ready for the next utterance

    async def _respond(self, turn: TurnTiming, text: str):
        await self.send_json({"type": "status", "state": "thinking"})
        _log("LLM start")
        reply = await asyncio.to_thread(self._run_llm, text, turn)
        _log(f"LLM done: {reply!r}")
        turn.text_bot = reply
        await self.send_json({"type": "transcript", "who": "BOT", "text": reply})
        await self._speak(reply, turn)
        turn.persist()
        await self.send_json(turn.to_ws_message())
        await self.send_json({"type": "status", "state": "listening"})  # back to listening (UI reset)

    def _run_llm(self, user_text: str, turn: TurnTiming) -> str:
        """Bedrock Converse stream + tool loop. Blocking; run in a thread."""
        messages = [{"role": "user", "content": [{"text": user_text}]}]
        turn.t_llm_req = now_ms()
        try:
            return self._run_llm_inner(messages, turn)
        except Exception as e:
            _log(f"LLM ERROR: {type(e).__name__}: {e}")
            turn.t_llm_done = now_ms()
            return "Sorry, something went wrong."

    def _run_llm_inner(self, messages: list, turn: TurnTiming) -> str:
        import json
        final_text_parts: list[str] = []
        for _ in range(4):  # bounded tool loop
            resp = self._bedrock.converse_stream(
                modelId=LLM_MODEL,
                system=[{"text": SYSTEM_PROMPT}],
                messages=messages,
                toolConfig=tools.TOOL_CONFIG,
                inferenceConfig={"maxTokens": 512, "temperature": 0.0},
            )
            # A single model turn can contain MULTIPLE content blocks (text +
            # one-or-more toolUse), keyed by contentBlockIndex. Accumulate each
            # block separately so a "weather in Paris AND time in New York" query
            # (two tools at once) doesn't concatenate their JSON inputs.
            blocks: dict = {}   # index -> {"text": str} | {"toolUseId","name","input": str}
            stop_reason = None
            for event in resp["stream"]:
                if "contentBlockStart" in event:
                    e = event["contentBlockStart"]
                    start = e.get("start", {})
                    if "toolUse" in start:
                        blocks[e["contentBlockIndex"]] = {
                            "toolUseId": start["toolUse"]["toolUseId"],
                            "name": start["toolUse"]["name"], "input": ""}
                elif "contentBlockDelta" in event:
                    e = event["contentBlockDelta"]
                    idx = e["contentBlockIndex"]
                    delta = e["delta"]
                    if "text" in delta:
                        if turn.t_llm_first_token is None:
                            turn.t_llm_first_token = now_ms()
                        b = blocks.setdefault(idx, {"text": ""})
                        b["text"] = b.get("text", "") + delta["text"]
                    elif "toolUse" in delta:
                        blocks.setdefault(idx, {"toolUseId": "", "name": "", "input": ""})
                        blocks[idx]["input"] += delta["toolUse"].get("input", "")
                elif "messageStop" in event:
                    stop_reason = event["messageStop"].get("stopReason")

            # Rebuild the assistant message + collect tool calls, in block order.
            assistant_content, tool_calls = [], []
            for idx in sorted(blocks):
                b = blocks[idx]
                if "toolUseId" in b:
                    args = json.loads(b["input"] or "{}")
                    assistant_content.append({"toolUse": {"toolUseId": b["toolUseId"], "name": b["name"], "input": args}})
                    tool_calls.append((b["toolUseId"], b["name"], args))
                elif b.get("text"):
                    assistant_content.append({"text": b["text"]})
                    final_text_parts.append(b["text"])

            if stop_reason == "tool_use" and tool_calls:
                messages.append({"role": "assistant", "content": assistant_content})
                results = []
                for tool_use_id, name, args in tool_calls:
                    results.append({"toolResult": {"toolUseId": tool_use_id,
                                                   "content": [{"json": tools.dispatch(name, args)}]}})
                messages.append({"role": "user", "content": results})
                continue  # let the model use the tool results
            break  # no tool use -> final answer
        turn.t_llm_done = now_ms()
        return "".join(final_text_parts).strip() or "Sorry, I didn't catch that."

    async def _speak(self, text: str, turn: TurnTiming):
        _, voice = _LOCALE[self.language]
        turn.t_tts_req = now_ms()
        _log(f"Polly synth: voice={voice} rate={OUT_RATE} text={text!r}")
        await self.send_json({"type": "status", "state": "speaking"})
        # VERIFY: Polly PCM output is 16 kHz max; stream AudioStream in chunks.
        resp = await asyncio.to_thread(
            self._polly.synthesize_speech,
            Text=text, OutputFormat="pcm", SampleRate=str(OUT_RATE),
            VoiceId=voice, Engine="neural",
        )
        body = resp["AudioStream"]
        first = True
        while True:
            chunk = await asyncio.to_thread(body.read, 8192)
            if not chunk:
                break
            if first:
                turn.t_tts_first_byte = now_ms()
                turn.t_first_audio_out = now_ms()
                first = False
            await self.send_audio(chunk)
        # Echo suppression is CLIENT-side (stream.js mutes the mic during playback),
        # which is precise and doesn't clip the user's next utterance.

    async def stop(self):
        self._closed = True
        try:
            if self._stream:
                await self._stream.input_stream.end_stream()
        except Exception:
            pass
        if self._handler_task:
            self._handler_task.cancel()
        if self._watch_task:
            self._watch_task.cancel()
