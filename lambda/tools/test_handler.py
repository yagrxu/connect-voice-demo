"""Tests for the Connect voice demo tools and MCP handler routing."""

import json
import types

import handler
import tools


# --- Pure tool logic --------------------------------------------------------

def test_get_weather_is_deterministic():
    a = tools.get_weather({"city": "Seattle"})
    b = tools.get_weather({"city": "Seattle"})
    assert a == b
    assert a["city"] == "Seattle"
    assert a["condition"] in tools.CONDITIONS
    assert -50 <= a["temperature_c"] <= 50


def test_get_weather_trims_and_is_case_insensitive_for_seed():
    assert tools.get_weather({"city": "  Seattle  "})["condition"] == \
        tools.get_weather({"city": "seattle"})["condition"]


def test_get_weather_invalid_args():
    assert tools.get_weather({})["error"] == "invalid_arguments"
    assert tools.get_weather({"city": "   "})["error"] == "invalid_arguments"
    assert tools.get_weather({"city": 123})["error"] == "invalid_arguments"


def test_get_current_time_default_utc():
    result = tools.get_current_time({})
    assert result["timezone"] == "UTC"
    assert "T" in result["timestamp"]


def test_get_current_time_named_zone():
    result = tools.get_current_time({"timezone": "Asia/Tokyo"})
    assert result["timezone"] == "Asia/Tokyo"


def test_get_current_time_invalid_zone():
    assert tools.get_current_time({"timezone": "Mars/Olympus"})["error"] == "invalid_timezone"


# --- MCP handler routing ----------------------------------------------------

def _ctx(tool_name):
    """Build a fake Lambda context carrying the AgentCore tool name."""
    client_context = types.SimpleNamespace(
        custom={"bedrockAgentCoreToolName": tool_name}
    )
    return types.SimpleNamespace(client_context=client_context)


def test_handler_routes_weather_with_target_prefix():
    out = json.loads(handler.lambda_handler({"city": "Paris"}, _ctx("demo-tools___get_weather")))
    assert out["city"] == "Paris"
    assert out["condition"] in tools.CONDITIONS


def test_handler_routes_time_without_prefix():
    out = json.loads(handler.lambda_handler({"timezone": "UTC"}, _ctx("get_current_time")))
    assert out["timezone"] == "UTC"


def test_handler_unknown_tool():
    out = json.loads(handler.lambda_handler({}, _ctx("demo-tools___nope")))
    assert out["error"] == "unknown_tool"
    assert out["tool"] == "nope"


def test_handler_missing_client_context():
    out = json.loads(handler.lambda_handler({}, types.SimpleNamespace()))
    assert out["error"] == "unknown_tool"
