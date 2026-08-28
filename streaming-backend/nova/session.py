"""Sonic_Session: Bedrock bidirectional stream wrapper (task 8).

Wraps the Amazon Bedrock ``InvokeModelWithBidirectionalStream`` operation
for the Nova Sonic model (``amazon.nova-2-sonic-v1:0``). The session
exposes a small, typed surface to the rest of the demo:

* :py:meth:`SonicSession.open` -- opens the Bedrock stream and emits the
  canonical ``sessionStart`` -> ``promptStart`` -> ``contentStart`` (audio)
  opener sequence under a 10-second deadline.
* :py:meth:`SonicSession.send_audio` -- base64-encodes one PCM frame and
  emits an ``audioInput`` event under the active prompt/content names.
* :py:meth:`SonicSession.stream_events` -- consumes the model's output
  stream, dispatches ``toolUse`` events through the
  :class:`ToolDispatcher`, and yields the remaining
  :class:`AudioOutEvent` and :class:`TranscriptEvent` records.
* :py:meth:`SonicSession.send_tool_result` -- emits the
  ``contentStart`` (TOOL) -> ``toolResult`` -> ``contentEnd`` triple for
  one tool result.
* :py:meth:`SonicSession.close` -- idempotent terminator that emits
  ``contentEnd`` -> ``promptEnd`` -> ``sessionEnd`` and closes the
  underlying input stream.

Design notes:

* The actual SDK shape for ``invoke_model_with_bidirectional_stream`` is
  intentionally hidden behind a small :class:`BidirectionalRpc` Protocol
  (``send_input``, ``close_input``, ``output``). Tests pass a
  ``FakeRpc`` and a fake ``client_factory`` so no AWS credentials are
  required and no real network call is made.
* All writes to the input stream (audio, tool result, terminators) are
  serialized by an :class:`asyncio.Lock` so concurrent producers cannot
  interleave events on the wire.
* Errors raised during :py:meth:`open` are classified into one of the
  documented :class:`BedrockOpenError` categories
  (``timeout``, ``auth``, ``region``, ``model``, ``network``).
"""

from __future__ import annotations

import asyncio
import base64
import json
import uuid
from typing import AsyncIterator, Callable, Optional, Protocol, Set

from .config import (
    MODEL_ID,
    SESSION_OPEN_TIMEOUT_S,
    BedrockOpenError,
)
from .events import (
    OutputEvent,
    ToolUseEvent,
    TranscriptEvent,
    audio_input_event,
    content_end_event,
    content_start_audio_input_event,
    content_start_text_input_event,
    content_start_tool_result_event,
    parse_output_event,
    prompt_end_event,
    prompt_start_event,
    session_end_event,
    session_start_event,
    text_input_event,
    tool_result_event,
)
# NOTE: registry / logger / dispatcher are passed in (duck-typed) by the
# nova_sonic_pipeline adapter — no dependency on chatbot-demo's tool registry.


# ---------------------------------------------------------------------------
# Bidirectional RPC abstraction
# ---------------------------------------------------------------------------


class BidirectionalRpc(Protocol):
    """Minimal shape the session needs from the Bedrock bidirectional stream.

    The default :func:`_default_client_factory` returns an SDK client whose
    ``invoke_model_with_bidirectional_stream`` coroutine yields an object
    matching this protocol. Tests pass a ``FakeRpc`` instead.
    """

    async def send_input(self, event: dict) -> None: ...

    async def close_input(self) -> None: ...

    def output(self) -> AsyncIterator[dict]: ...


def _default_client_factory(region: str):  # pragma: no cover - thin SDK adapter
    """Build the default Nova Sonic Bedrock-runtime adapter.

    Wraps the experimental ``aws_sdk_bedrock_runtime`` async client in a
    :class:`BidirectionalRpc`-shaped adapter so the rest of the session
    code stays decoupled from the SDK's exact shape. Imported lazily so
    tests that inject their own ``client_factory`` do not need the SDK
    installed.

    Credentials are resolved through ``boto3`` first (which already
    supports the full SDK chain: env vars, shared credentials file,
    named profiles, SSO, IMDS, etc.) and then fed into
    :class:`StaticCredentialsResolver`. The smithy SDK's built-in
    ``create_default_chain`` only covers env + IMDS, so the boto3
    bridge is what lets a developer rely on a default profile.
    """

    import boto3

    from aws_sdk_bedrock_runtime.client import (
        BedrockRuntimeClient,
        InvokeModelWithBidirectionalStreamOperationInput,
    )
    from aws_sdk_bedrock_runtime.config import Config
    from aws_sdk_bedrock_runtime.models import (
        BidirectionalInputPayloadPart,
        InvokeModelWithBidirectionalStreamInputChunk,
    )
    from smithy_aws_core.identity.components import AWSCredentialsIdentity
    from smithy_core.aio.interfaces.identity import IdentityResolver

    session = boto3.Session()
    creds = session.get_credentials()
    if creds is None:
        raise BedrockOpenError(
            "auth",
            "AWS credentials could not be resolved from the standard SDK chain",
        )

    frozen = creds.get_frozen_credentials()
    aws_identity = AWSCredentialsIdentity(
        access_key_id=frozen.access_key,
        secret_access_key=frozen.secret_key,
        session_token=frozen.token,
    )

    class _Boto3BridgeCredentialsResolver(IdentityResolver):
        """Hand the boto3-resolved credentials to the smithy stack.

        boto3 itself supports the default profile, named profiles, SSO,
        the shared credentials file, env vars, and IMDS. We resolve once
        at startup and replay the snapshot for every signing request.
        Short-lived SSO/role credentials are still good for the demo's
        8-minute session window.
        """

        async def get_identity(self, *, properties=None):
            return aws_identity

    config = Config(
        endpoint_uri=f"https://bedrock-runtime.{region}.amazonaws.com",
        region=region,
        aws_credentials_identity_resolver=_Boto3BridgeCredentialsResolver(),
    )
    client = BedrockRuntimeClient(config=config)

    class _SdkClientAdapter:
        """Adapter exposing ``invoke_model_with_bidirectional_stream(modelId=, body=)``.

        Returns an :class:`_SdkRpcAdapter` matching :class:`BidirectionalRpc`.
        """

        async def invoke_model_with_bidirectional_stream(self, *, modelId, body=b""):
            stream = await client.invoke_model_with_bidirectional_stream(
                InvokeModelWithBidirectionalStreamOperationInput(model_id=modelId)
            )
            return _SdkRpcAdapter(
                stream,
                InvokeModelWithBidirectionalStreamInputChunk,
                BidirectionalInputPayloadPart,
            )

    return _SdkClientAdapter()


class _SdkRpcAdapter:
    """Translate :class:`BidirectionalRpc` calls into the SDK's wire shape."""

    def __init__(self, stream, input_chunk_cls, payload_part_cls) -> None:
        self._stream = stream
        self._input_chunk_cls = input_chunk_cls
        self._payload_part_cls = payload_part_cls
        self._input_closed = False

    async def send_input(self, event: dict) -> None:
        payload = json.dumps(event).encode("utf-8")
        chunk = self._input_chunk_cls(value=self._payload_part_cls(bytes_=payload))
        await self._stream.input_stream.send(chunk)

    async def close_input(self) -> None:
        if self._input_closed:
            return
        self._input_closed = True
        try:
            await self._stream.input_stream.close()
        except Exception:
            pass

    async def output(self):  # type: ignore[override]
        """Yield raw event dicts decoded from the SDK's typed output stream."""
        while True:
            try:
                output = await self._stream.await_output()
            except Exception as e:
                print(f"[sonic-out] await_output ended: {type(e).__name__}: {e}", flush=True)
                return
            try:
                result = await output[1].receive()
            except Exception as e:
                print(f"[sonic-out] receive ended: {type(e).__name__}: {e}", flush=True)
                return
            value = getattr(result, "value", None)
            raw_bytes = getattr(value, "bytes_", None) if value is not None else None
            if not raw_bytes:
                continue
            try:
                yield json.loads(raw_bytes.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue


# ---------------------------------------------------------------------------
# SonicSession
# ---------------------------------------------------------------------------


_AUTH_ERROR_CODES = frozenset(
    {
        "UnrecognizedClientException",
        "InvalidSignatureException",
        "AccessDeniedException",
        "ExpiredTokenException",
    }
)


class SonicSession:
    """Bedrock bidirectional stream wrapper for Nova Sonic."""

    def __init__(
        self,
        region: str,
        registry,
        logger,
        dispatcher,
        *,
        client_factory: Optional[Callable[[str], object]] = None,
        system_prompt: Optional[str] = None,
        prompt_id_factory: Optional[Callable[[], str]] = None,
        content_id_factory: Optional[Callable[[], str]] = None,
        open_timeout_s: float = SESSION_OPEN_TIMEOUT_S,
    ) -> None:
        self._region = region
        self._registry = registry
        self._logger = logger
        self._dispatcher = dispatcher
        self._client_factory = client_factory or _default_client_factory
        self._system_prompt = system_prompt
        self._prompt_id_factory = prompt_id_factory or (lambda: str(uuid.uuid4()))
        self._content_id_factory = content_id_factory or (lambda: str(uuid.uuid4()))
        self._open_timeout_s = open_timeout_s

        self._client: object | None = None
        self._rpc: Optional[BidirectionalRpc] = None
        self._prompt_name: str = ""
        self._content_name: str = ""
        self._opened: bool = False
        self._closed: bool = False
        self._write_lock: asyncio.Lock = asyncio.Lock()
        self._tool_tasks: Set[asyncio.Task] = set()

    # ------------------------------------------------------------------
    # Public lifecycle
    # ------------------------------------------------------------------

    async def open(self) -> None:
        """Open the Bedrock stream and emit the opener event sequence.

        Wraps the entire opener handshake in :func:`asyncio.wait_for` with
        the configured deadline. Translates any failure into a
        :class:`BedrockOpenError` carrying a categorised error type and
        the underlying exception.
        """

        if self._opened or self._closed:
            return
        try:
            await asyncio.wait_for(self._open_inner(), timeout=self._open_timeout_s)
        except asyncio.TimeoutError as exc:
            await self._safe_close_rpc()
            raise BedrockOpenError("timeout", exc) from exc
        except BedrockOpenError:
            await self._safe_close_rpc()
            raise
        except Exception as exc:  # noqa: BLE001 - we deliberately catch all.
            category = self._classify_open_error(exc)
            await self._safe_close_rpc()
            raise BedrockOpenError(category, exc) from exc

    async def send_audio(self, pcm_bytes: bytes) -> None:
        """Base64-encode ``pcm_bytes`` and emit one ``audioInput`` event."""

        if self._closed:
            raise RuntimeError("session closed")
        if not self._opened or self._rpc is None:
            raise RuntimeError("session not open")

        b64 = base64.b64encode(pcm_bytes).decode("ascii")
        evt = audio_input_event(self._prompt_name, self._content_name, b64)
        async with self._write_lock:
            await self._rpc.send_input(evt)

    async def stream_events(self) -> AsyncIterator[OutputEvent]:
        """Yield non-tool output events; route ``toolUse`` to the dispatcher.

        Tool-use events are handled in the background by
        :py:meth:`_handle_tool_use` so the caller never has to think about
        the tool-result round-trip.

        Nova Sonic emits each ASSISTANT transcript twice — once as
        ``SPECULATIVE`` while the audio is still streaming, and once as
        the canonical ``FINAL`` version that goes into the conversation
        history. We track the most recent ASSISTANT ``contentStart``'s
        ``generationStage`` and suppress the FINAL re-broadcast so the
        demo prints each utterance only once. The SPECULATIVE copy is
        preferred because it appears in time with the spoken audio
        rather than after it ends.

        ``generationStage`` only appears on ASSISTANT contentStart
        events, so we reset the gate on every contentStart that does
        not carry one (USER, TOOL, SYSTEM). That keeps a stale FINAL
        from one turn from suppressing the next turn's transcript.
        """

        if self._rpc is None:
            return
        # "SPECULATIVE" means "show the next ASSISTANT transcript".
        # "FINAL" means "skip the next ASSISTANT transcript".
        assistant_stage = "SPECULATIVE"
        async for raw in self._rpc.output():
            try:
                print(f"[sonic-raw] {list(raw.get('event', {}).keys()) if isinstance(raw, dict) else type(raw)}", flush=True)
            except Exception:
                pass
            inner = raw.get("event", raw) if isinstance(raw, dict) else None

            if isinstance(inner, dict) and "contentStart" in inner:
                cs = inner["contentStart"]
                if isinstance(cs, dict):
                    extra = cs.get("additionalModelFields")
                    if isinstance(extra, str):
                        try:
                            extra = json.loads(extra)
                        except (TypeError, ValueError):
                            extra = None
                    if isinstance(extra, dict) and isinstance(
                        extra.get("generationStage"), str
                    ):
                        assistant_stage = extra["generationStage"]
                    else:
                        # USER / TOOL / SYSTEM contentStart: reset the gate
                        # so a stale FINAL doesn't bleed across turns.
                        assistant_stage = "SPECULATIVE"
                continue  # contentStart is metadata only

            event = parse_output_event(raw)
            if event is None:
                continue
            if isinstance(event, ToolUseEvent):
                task = asyncio.create_task(self._handle_tool_use(event))
                self._tool_tasks.add(task)
                task.add_done_callback(self._tool_tasks.discard)
                continue

            # Skip the FINAL re-broadcast of an ASSISTANT transcript;
            # the user already saw and heard the SPECULATIVE one.
            if (
                isinstance(event, TranscriptEvent)
                and event.role == "ASSISTANT"
                and assistant_stage == "FINAL"
            ):
                continue

            yield event

    async def send_tool_result(self, tool_use_id: str, result: dict) -> None:
        """Emit ``contentStart`` (TOOL) / ``toolResult`` / ``contentEnd``."""

        if self._closed:
            raise RuntimeError("session closed")
        if not self._opened or self._rpc is None:
            raise RuntimeError("session not open")

        fresh_content_name = self._content_id_factory()
        try:
            content_json = json.dumps(result)
        except (TypeError, ValueError):
            # Defensive: dispatcher results are JSON-shaped, but if a
            # custom dispatcher returns something exotic, encode an
            # explicit error instead of crashing the session.
            content_json = json.dumps({"error": "non_serializable_result"})

        async with self._write_lock:
            await self._rpc.send_input(
                content_start_tool_result_event(
                    self._prompt_name, fresh_content_name, tool_use_id
                )
            )
            await self._rpc.send_input(
                tool_result_event(self._prompt_name, fresh_content_name, content_json)
            )
            await self._rpc.send_input(
                content_end_event(self._prompt_name, fresh_content_name)
            )

    async def close(self) -> None:
        """Idempotently emit terminators and close the input stream."""

        if self._closed:
            return
        self._closed = True

        # Cancel any in-flight tool dispatch tasks. They observe the
        # cancel and return without trying to write to the (about to be
        # closed) input stream.
        for task in list(self._tool_tasks):
            task.cancel()

        if self._opened and self._rpc is not None:
            terminators = (
                content_end_event(self._prompt_name, self._content_name),
                prompt_end_event(self._prompt_name),
                session_end_event(),
            )
            async with self._write_lock:
                for evt in terminators:
                    try:
                        await self._rpc.send_input(evt)
                    except Exception:
                        # A partial failure must not prevent later
                        # terminators or the close_input call below.
                        pass

        if self._rpc is not None:
            try:
                await self._rpc.close_input()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _open_inner(self) -> None:
        self._client = self._client_factory(self._region)
        invoke = getattr(self._client, "invoke_model_with_bidirectional_stream")
        rpc = await invoke(modelId=MODEL_ID, body=b"")
        self._rpc = rpc

        self._prompt_name = self._prompt_id_factory()
        self._content_name = self._content_id_factory()

        async with self._write_lock:
            await rpc.send_input(session_start_event())
            await rpc.send_input(
                prompt_start_event(
                    self._prompt_name,
                    self._registry.to_bedrock_config(),
                    None,  # system prompt is delivered as a TEXT triple below
                )
            )
            if self._system_prompt:
                sys_content_name = self._content_id_factory()
                await rpc.send_input(
                    content_start_text_input_event(
                        self._prompt_name, sys_content_name, role="SYSTEM"
                    )
                )
                await rpc.send_input(
                    text_input_event(
                        self._prompt_name, sys_content_name, self._system_prompt
                    )
                )
                await rpc.send_input(
                    content_end_event(self._prompt_name, sys_content_name)
                )
            await rpc.send_input(
                content_start_audio_input_event(
                    self._prompt_name, self._content_name
                )
            )

        self._opened = True

    async def _handle_tool_use(self, event: ToolUseEvent) -> None:
        try:
            result = await self._dispatcher.dispatch(
                event.tool_use_id, event.tool_name, event.arguments
            )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - dispatcher already shapes errors.
            return

        try:
            await self.send_tool_result(event.tool_use_id, result)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Session may be closing or the input stream may be gone.
            # The session keeps running; missing one tool result must
            # not bring it down.
            pass

    async def _safe_close_rpc(self) -> None:
        rpc = self._rpc
        if rpc is None:
            return
        try:
            await rpc.close_input()
        except Exception:
            pass

    @staticmethod
    def _classify_open_error(exc: Exception) -> str:
        """Map an SDK exception to a :class:`BedrockOpenError` category."""

        # Lazy import so unit tests that inject their own client_factory
        # do not need botocore installed.
        ClientError = None
        EndpointConnectionError = None
        try:  # pragma: no cover - import shape depends on env.
            from botocore.exceptions import (  # type: ignore
                ClientError as _ClientError,
                EndpointConnectionError as _EndpointConnectionError,
            )

            ClientError = _ClientError
            EndpointConnectionError = _EndpointConnectionError
        except Exception:
            pass

        if ClientError is not None and isinstance(exc, ClientError):
            response = getattr(exc, "response", {}) or {}
            err = response.get("Error", {}) if isinstance(response, dict) else {}
            code = err.get("Code", "") if isinstance(err, dict) else ""
            message = err.get("Message", "") if isinstance(err, dict) else ""

            if code in _AUTH_ERROR_CODES:
                return "auth"
            if code == "ValidationException" and "region" in (message or "").lower():
                return "region"
            if code == "ResourceNotFoundException":
                return "model"
            return "model"

        if EndpointConnectionError is not None and isinstance(
            exc, EndpointConnectionError
        ):
            return "network"
        if isinstance(exc, (ConnectionError, OSError)):
            return "network"

        return "model"


__all__ = [
    "BidirectionalRpc",
    "SonicSession",
]
