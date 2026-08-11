"""AgentCore Gateway (MCP) Lambda handler for the Connect voice demo tools.

AgentCore Gateway invokes this Lambda for each MCP tool call:
  - ``event`` is the tool input parameters directly, e.g. {"city": "Seattle"}.
  - The tool name arrives in
    ``context.client_context.custom["bedrockAgentCoreToolName"]`` as
    "<target>___<tool_name>" (the target prefix is stripped with the "___"
    delimiter, following the AgentCore Gateway convention).

The handler routes to the pure functions in ``tools.py`` and returns the
result as a JSON string. Unknown tools and bad arguments return structured
``{"error": ...}`` payloads so the AI agent can respond gracefully instead of
the invocation failing.
"""

from __future__ import annotations

import json

from tools import TOOLS

_DELIMITER = "___"


def _resolve_tool_name(context) -> str:
    """Extract the bare tool name from the AgentCore Gateway client context."""
    try:
        raw = context.client_context.custom.get("bedrockAgentCoreToolName", "")
    except AttributeError:
        raw = ""
    if _DELIMITER in raw:
        return raw[raw.index(_DELIMITER) + len(_DELIMITER):]
    return raw


def lambda_handler(event, context):
    """Dispatch an MCP tool call to the matching tool function."""
    tool_name = _resolve_tool_name(context)

    tool = TOOLS.get(tool_name)
    if tool is None:
        return json.dumps({"error": "unknown_tool", "tool": tool_name})

    # Gateway passes the tool arguments as the event body directly.
    args = event if isinstance(event, dict) else {}

    try:
        result = tool(args)
    except Exception as exc:  # defensive: never let the invocation crash
        message = str(exc)[:200] or type(exc).__name__[:200]
        result = {"error": message}

    return json.dumps(result)
