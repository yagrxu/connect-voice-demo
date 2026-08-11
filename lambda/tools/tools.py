"""Pure tool functions for the Connect voice demo.

These are the same two deterministic tools the original Nova Sonic demo
exposed (get_current_time, get_weather). No external APIs — the demo runs
offline and returns stable, repeatable results.

Kept deliberately simple: each function takes a plain dict of arguments and
returns a JSON-serializable dict. Errors are returned as {"error": <code>}
rather than raised, so the caller can hand the result straight back to the
AI agent.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Same conditions list as the original demo's weather tool.
CONDITIONS = ("sunny", "cloudy", "rainy", "snowy", "windy")


def _stable_seed(city: str) -> int:
    """Produce a deterministic integer seed from a city name."""
    digest = hashlib.sha256(city.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big", signed=False)


def get_weather(args: dict) -> dict:
    """Return a deterministic mocked weather report for a city.

    Same algorithm as the original demo: hash the lowercased city name into a
    stable seed, pick a condition and a temperature in [-50, 50]. Returns
    {"error": "invalid_arguments"} when city is missing or empty.
    """
    raw_city = args.get("city") if isinstance(args, dict) else None
    if not isinstance(raw_city, str):
        return {"error": "invalid_arguments"}

    city = raw_city.strip()
    if not city:
        return {"error": "invalid_arguments"}

    seed = _stable_seed(city.lower())
    condition = CONDITIONS[seed % len(CONDITIONS)]
    temperature_c = (seed % 101) - 50

    return {
        "city": city,
        "condition": condition,
        "temperature_c": temperature_c,
    }


def get_current_time(args: dict) -> dict:
    """Return the current ISO 8601 timestamp in the requested timezone.

    Defaults to UTC when no timezone is given. Returns
    {"error": "invalid_timezone"} for an unrecognized timezone name.
    """
    tz_name = args.get("timezone") if isinstance(args, dict) else None
    if not tz_name:
        tz_name = "UTC"
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, Exception):
        return {"error": "invalid_timezone"}
    now = datetime.now(tz)
    return {"timestamp": now.isoformat(), "timezone": tz_name}


# Tool registry: name -> callable. Kept here so the handler stays thin.
TOOLS = {
    "get_current_time": get_current_time,
    "get_weather": get_weather,
}
