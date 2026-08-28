"""方案 B streaming backend — FastAPI WebSocket server (AgentCore Runtime).

One WebSocket per browser session:
  - text frame {"type":"start","pipeline":"transcribe","language":"en_US"}
  - binary frames = 16 kHz mono Int16 PCM from the mic
  - server -> binary = PCM audio to play; text = status/transcript/tool/timing JSON
  - text frame {"type":"stop"} ends the session

`pipeline=transcribe` is served here (transcribe_pipeline.py). `pipeline=nova-sonic`
is served by REUSING chatbot-demo's Strands/BidiAgent AgentCore agent — the Node
proxy routes that pipeline to that separate runtime, not to this server.

⚠️ SCAFFOLD — not yet deployed. See docs/latency-optimization-plan.md (方案 B).
"""
from __future__ import annotations

import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from transcribe_pipeline import TranscribePipeline

app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True}


@app.websocket("/ws/session")
async def ws_session(ws: WebSocket):
    await ws.accept()
    session_id = ws.headers.get("x-session-id") or ws.client.host + ":" + str(ws.client.port)
    pipeline = None

    async def send_audio(pcm: bytes):
        await ws.send_bytes(pcm)

    async def send_json(obj: dict):
        await ws.send_text(json.dumps(obj))

    try:
        while True:
            msg = await ws.receive()
            mtype = msg.get("type")
            if mtype == "websocket.disconnect":
                print(f"[ws] disconnect code={msg.get('code')}", flush=True)
                break
            if msg.get("bytes") is not None:
                if pipeline:
                    await pipeline.feed_audio(msg["bytes"])
                continue
            if msg.get("text") is None:
                continue
            data = json.loads(msg["text"])
            print(f"[ws] control: {data.get('type')}", flush=True)
            if data.get("type") == "start":
                kind = data.get("pipeline", "transcribe")
                lang = data.get("language", "en_US")
                if kind == "nova-sonic":
                    # Nova Sonic runs in a SEPARATE service (awscrt version conflict
                    # with amazon-transcribe). The browser should target its WS URL.
                    await send_json({"type": "error", "message": "nova-sonic is served by a separate endpoint"})
                    continue
                pipeline = TranscribePipeline(session_id, lang, send_audio, send_json)
                await pipeline.start()
            elif data.get("type") == "stop":
                break
    except WebSocketDisconnect:
        print("[ws] WebSocketDisconnect", flush=True)
    except Exception as e:
        import traceback
        print(f"[ws] handler EXCEPTION: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
    finally:
        print("[ws] closing session -> pipeline.stop()", flush=True)
        if pipeline:
            await pipeline.stop()
