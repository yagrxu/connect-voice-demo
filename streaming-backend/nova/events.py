"""Nova Sonic input/output event builders and parsers (task 4).

This module is intentionally pure: every builder is a free function that
returns a JSON-serializable :class:`dict` shaped exactly as the Nova Sonic
bidirectional-stream wire protocol expects, namely::

    {"event": {<eventName>: {...}}}

The output-event parser :func:`parse_output_event` accepts either a raw
event dict (already unwrapped) or one that still has the ``"event"``
envelope, and returns a typed, frozen dataclass for the three event kinds
the demo cares about (audio output, transcripts, tool use). All other
event kinds, malformed payloads, or unexpected exceptions yield ``None``
so the caller can simply skip them without try/except plumbing.

The shapes mirror the protocol described in ``design.md`` and the Nova
Sonic public documentation.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Any, Literal, Union


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------


DEFAULT_INFERENCE_CONFIG: dict = {
    "maxTokens": 1024,
    "topP": 0.9,
    "temperature": 0.7,
}


# ---------------------------------------------------------------------------
# Input event builders
# ---------------------------------------------------------------------------


def session_start_event(inference_config: dict | None = None) -> dict:
    """Build the ``sessionStart`` input event.

    Parameters
    ----------
    inference_config:
        Optional inference configuration override. When ``None``, the
        canonical :data:`DEFAULT_INFERENCE_CONFIG` is used verbatim.
    """

    config = inference_config if inference_config is not None else DEFAULT_INFERENCE_CONFIG
    return {
        "event": {
            "sessionStart": {
                "inferenceConfiguration": config,
            }
        }
    }


def prompt_start_event(
    prompt_name: str,
    tool_config: dict,
    system_prompt: str | None = None,
) -> dict:
    """Build the ``promptStart`` input event.

    The supplied ``tool_config`` dict is carried verbatim under the
    ``toolConfiguration`` key. When ``system_prompt`` is non-empty,
    a ``system`` field is added to the inner ``promptStart`` object.
    """

    inner: dict[str, Any] = {
        "promptName": prompt_name,
        "textOutputConfiguration": {"mediaType": "text/plain"},
        "audioOutputConfiguration": {
            "mediaType": "audio/lpcm",
            "sampleRateHertz": 24000,
            "sampleSizeBits": 16,
            "channelCount": 1,
            "voiceId": "matthew",
            "encoding": "base64",
            "audioType": "SPEECH",
        },
        "toolUseOutputConfiguration": {"mediaType": "application/json"},
        "toolConfiguration": tool_config,
    }
    if system_prompt:
        inner["system"] = system_prompt
    return {"event": {"promptStart": inner}}


def content_start_audio_input_event(prompt_name: str, content_name: str) -> dict:
    """Build a ``contentStart`` event opening a USER audio-input turn."""

    return {
        "event": {
            "contentStart": {
                "promptName": prompt_name,
                "contentName": content_name,
                "type": "AUDIO",
                "interactive": True,
                "role": "USER",
                "audioInputConfiguration": {
                    "mediaType": "audio/lpcm",
                    "sampleRateHertz": 16000,
                    "sampleSizeBits": 16,
                    "channelCount": 1,
                    "audioType": "SPEECH",
                    "encoding": "base64",
                },
            }
        }
    }


def audio_input_event(prompt_name: str, content_name: str, audio_b64: str) -> dict:
    """Build an ``audioInput`` event carrying one base64-encoded PCM frame."""

    return {
        "event": {
            "audioInput": {
                "promptName": prompt_name,
                "contentName": content_name,
                "content": audio_b64,
            }
        }
    }


def content_end_event(prompt_name: str, content_name: str) -> dict:
    """Build a ``contentEnd`` event closing a content block."""

    return {
        "event": {
            "contentEnd": {
                "promptName": prompt_name,
                "contentName": content_name,
            }
        }
    }


def prompt_end_event(prompt_name: str) -> dict:
    """Build a ``promptEnd`` event closing the prompt."""

    return {"event": {"promptEnd": {"promptName": prompt_name}}}


def session_end_event() -> dict:
    """Build the terminal ``sessionEnd`` event."""

    return {"event": {"sessionEnd": {}}}


# ---------------------------------------------------------------------------
# Text input helpers (system prompts)
# ---------------------------------------------------------------------------


def content_start_text_input_event(
    prompt_name: str,
    content_name: str,
    role: Literal["SYSTEM", "USER"] = "SYSTEM",
) -> dict:
    """Build a ``contentStart`` opener for a TEXT content block.

    Used to deliver a system prompt before audio input begins, mirroring
    the canonical Nova Sonic pattern (one-shot SYSTEM text content
    opened, sent via ``textInput``, then closed with ``contentEnd``).
    """

    return {
        "event": {
            "contentStart": {
                "promptName": prompt_name,
                "contentName": content_name,
                "type": "TEXT",
                "interactive": False,
                "role": role,
                "textInputConfiguration": {"mediaType": "text/plain"},
            }
        }
    }


def text_input_event(prompt_name: str, content_name: str, content: str) -> dict:
    """Build a ``textInput`` event carrying the literal text payload."""

    return {
        "event": {
            "textInput": {
                "promptName": prompt_name,
                "contentName": content_name,
                "content": content,
            }
        }
    }


# ---------------------------------------------------------------------------
# Tool-result helpers
# ---------------------------------------------------------------------------


def content_start_tool_result_event(
    prompt_name: str,
    content_name: str,
    tool_use_id: str,
) -> dict:
    """Build the ``contentStart`` opener for a tool-result content block."""

    return {
        "event": {
            "contentStart": {
                "promptName": prompt_name,
                "contentName": content_name,
                "interactive": False,
                "type": "TOOL",
                "role": "TOOL",
                "toolResultInputConfiguration": {
                    "toolUseId": tool_use_id,
                    "type": "TEXT",
                    "textInputConfiguration": {"mediaType": "text/plain"},
                },
            }
        }
    }


def tool_result_event(prompt_name: str, content_name: str, content_json: str) -> dict:
    """Build a ``toolResult`` event carrying the JSON-encoded result string."""

    return {
        "event": {
            "toolResult": {
                "promptName": prompt_name,
                "contentName": content_name,
                "content": content_json,
            }
        }
    }


# ---------------------------------------------------------------------------
# Output event parsing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AudioOutEvent:
    """Decoded audio-output frame from the model."""

    pcm: bytes


@dataclass(frozen=True)
class TranscriptEvent:
    """Final transcript segment from the model."""

    role: Literal["USER", "ASSISTANT"]
    text: str
    is_final: bool


@dataclass(frozen=True)
class ToolUseEvent:
    """Tool-use request emitted by the model."""

    tool_use_id: str
    tool_name: str
    arguments: dict


OutputEvent = Union[AudioOutEvent, TranscriptEvent, ToolUseEvent]


def _unwrap(raw: dict) -> dict | None:
    """Return the inner event dict, accepting both wrapped and unwrapped input."""

    if not isinstance(raw, dict):
        return None
    if "event" in raw and isinstance(raw["event"], dict):
        return raw["event"]
    return raw


def _parse_audio_output(payload: dict) -> AudioOutEvent | None:
    content = payload.get("content")
    if not isinstance(content, str):
        return None
    try:
        pcm = base64.b64decode(content, validate=True)
    except (binascii.Error, ValueError):
        return None
    return AudioOutEvent(pcm=pcm)


def _parse_text_output(payload: dict) -> TranscriptEvent | None:
    role = payload.get("role")
    text = payload.get("content")
    if role not in ("USER", "ASSISTANT"):
        return None
    if not isinstance(text, str):
        return None
    return TranscriptEvent(role=role, text=text, is_final=True)


def _parse_tool_use(payload: dict) -> ToolUseEvent | None:
    tool_use_id = payload.get("toolUseId")
    tool_name = payload.get("toolName")
    if not isinstance(tool_use_id, str) or not isinstance(tool_name, str):
        return None
    # Nova Sonic carries the tool arguments under ``content`` in the
    # toolUse output event (see the official aws-samples
    # ``nova_sonic_tool_use.py`` sample). Older Bedrock model families
    # used ``input`` or ``arguments``, so we accept those as fallbacks.
    raw_input = payload.get("content")
    if raw_input is None:
        raw_input = payload.get("input")
    if raw_input is None:
        raw_input = payload.get("arguments")

    # ``content`` may arrive as either a JSON string or a parsed dict
    # depending on the SDK serialization path. Normalise to dict.
    if isinstance(raw_input, dict):
        arguments = raw_input
    elif isinstance(raw_input, str):
        try:
            arguments = json.loads(raw_input)
        except (ValueError, TypeError):
            return None
    else:
        return None

    if not isinstance(arguments, dict):
        return None
    return ToolUseEvent(
        tool_use_id=tool_use_id,
        tool_name=tool_name,
        arguments=arguments,
    )


def parse_output_event(raw: dict) -> OutputEvent | None:
    """Parse a Nova Sonic output event into a typed dataclass.

    Returns ``None`` for unknown event kinds, malformed payloads, or
    unexpected exceptions. The function never raises.
    """

    try:
        inner = _unwrap(raw)
        if not isinstance(inner, dict):
            return None

        if "audioOutput" in inner:
            payload = inner["audioOutput"]
            if not isinstance(payload, dict):
                return None
            return _parse_audio_output(payload)

        if "textOutput" in inner:
            payload = inner["textOutput"]
            if not isinstance(payload, dict):
                return None
            return _parse_text_output(payload)

        if "toolUse" in inner:
            payload = inner["toolUse"]
            if not isinstance(payload, dict):
                return None
            return _parse_tool_use(payload)

        return None
    except Exception:  # pragma: no cover - defensive last-resort guard
        return None


__all__ = [
    "DEFAULT_INFERENCE_CONFIG",
    "session_start_event",
    "prompt_start_event",
    "content_start_audio_input_event",
    "audio_input_event",
    "content_end_event",
    "prompt_end_event",
    "session_end_event",
    "content_start_text_input_event",
    "text_input_event",
    "content_start_tool_result_event",
    "tool_result_event",
    "AudioOutEvent",
    "TranscriptEvent",
    "ToolUseEvent",
    "OutputEvent",
    "parse_output_event",
]
