"""Per-turn latency timestamps → DynamoDB (方案 B).

One row per turn, keyed by (sessionId, turnId), tagged with `pipeline`. The web
latency panel reads these for a PRECISE ASR/LLM/TTS split — unlike the Connect
pipeline where ASR/TTS are only ≈ estimated. All times are epoch-ms.

Table (created by CDK, ConnectVoiceDemo-turn-timings):
  PK sessionId (S), SK turnId (S), TTL attribute `ttl`.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, asdict, field

import boto3

_TABLE_NAME = os.environ.get("TURN_TIMINGS_TABLE", "ConnectVoiceDemo-turn-timings")
_ddb = boto3.resource("dynamodb")


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class TurnTiming:
    session_id: str
    turn_id: str
    pipeline: str  # "transcribe" | "nova-sonic"
    t_recv: int | None = None            # first audio frame of the user turn reached us
    t_asr_first_partial: int | None = None
    t_speech_end: int | None = None      # last VAD speech frame (user actually stopped talking)
    t_asr_final: int | None = None
    t_llm_req: int | None = None
    t_llm_first_token: int | None = None
    t_llm_done: int | None = None
    t_tts_req: int | None = None
    t_tts_first_byte: int | None = None
    t_first_audio_out: int | None = None  # first audio byte sent back to the browser
    model: str | None = None
    text_user: str | None = None
    text_bot: str | None = None
    extra: dict = field(default_factory=dict)

    def derived(self) -> dict:
        """Stage durations for the UI (ms). None where a boundary is missing.

        Anchored to END OF SPEECH (t_speech_end, the last VAD speech frame), NOT
        speech onset — so how long the caller talked doesn't inflate the numbers.
        `asr` becomes the post-speech endpointing + final-transcript settle; `e2e`
        is the response latency the caller actually feels (stopped talking → hears
        a reply). Falls back to t_asr_final / onset when VAD end isn't available.
        """
        def d(a, b):
            return (b - a) if (a is not None and b is not None and b >= a) else None
        anchor = self.t_speech_end or self.t_asr_final or self.t_asr_first_partial or self.t_recv
        return {
            "asr": d(anchor, self.t_asr_final),
            "llm": d(self.t_llm_req, self.t_llm_done),
            "tts": d(self.t_tts_req, self.t_first_audio_out),
            "e2e": d(anchor, self.t_first_audio_out),
            "llm_ttft": d(self.t_llm_req, self.t_llm_first_token),
        }

    def persist(self, ttl_days: int = 7) -> None:
        item = {k: v for k, v in asdict(self).items() if v is not None and k not in ("extra",)}
        item["sessionId"] = item.pop("session_id")
        item["turnId"] = item.pop("turn_id")
        item["ttl"] = int(time.time()) + ttl_days * 86400
        if self.extra:
            item.update(self.extra)
        try:
            _ddb.Table(_TABLE_NAME).put_item(Item=item)
        except Exception as e:  # never let telemetry break the call
            print(f"[timings] put_item failed: {e}")

    def to_ws_message(self) -> dict:
        """Payload for the browser latency panel (stream.js onTiming)."""
        d = self.derived()
        return {"type": "timing", "turnId": self.turn_id, "pipeline": self.pipeline, **d}
