"""Deterministic demo tools — get_current_time / get_weather.

Byte-for-byte behaviour matches connect-demo (lambda/tools) and chatbot-demo:
no external APIs, deterministic weather from a hash so demos are offline-safe.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# Bedrock Converse toolConfig schema for these two tools.
TOOL_CONFIG = {
    "tools": [
        {
            "toolSpec": {
                "name": "get_current_time",
                "description": "Get the current time. Pass an IANA timezone (e.g. Asia/Tokyo); omit for UTC.",
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {"timezone": {"type": "string"}},
                }},
            }
        },
        {
            "toolSpec": {
                "name": "get_weather",
                "description": "Get a short weather report for a city.",
                "inputSchema": {"json": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                }},
            }
        },
    ]
}

_CONDITIONS = ["sunny", "cloudy", "rainy", "windy", "foggy", "snowy"]


def get_current_time(timezone_name: str | None = None) -> dict:
    tz = ZoneInfo(timezone_name) if timezone_name else timezone.utc
    now = datetime.now(tz)
    return {
        "timezone": timezone_name or "UTC",
        "iso": now.isoformat(),
        # Pre-formatted spoken form so the model needn't parse ISO.
        "spoken": now.strftime("%I:%M %p").lstrip("0"),
    }


def get_weather(city: str) -> dict:
    seed = int(hashlib.sha256(city.lower().encode()).hexdigest(), 16)
    condition = _CONDITIONS[seed % len(_CONDITIONS)]
    temp_c = 5 + (seed >> 8) % 26  # 5..30 C, deterministic
    return {"city": city, "condition": condition, "temperature_c": temp_c}


def dispatch(name: str, args: dict) -> dict:
    if name == "get_current_time":
        return get_current_time(args.get("timezone"))
    if name == "get_weather":
        return get_weather(args["city"])
    raise ValueError(f"unknown tool: {name}")
