"""Nova Sonic WS service (separate from the Transcribe service due to awscrt
version conflict). Serves /ws/nova; ALB routes that path here."""
from __future__ import annotations
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from nova_sonic_pipeline import NovaSonicPipeline

app = FastAPI()

@app.get("/health")
def health():
    return {"ok": True}

@app.websocket("/ws/nova")
async def ws_nova(ws: WebSocket):
    await ws.accept()
    session_id = ws.headers.get("x-session-id") or f"{ws.client.host}:{ws.client.port}"
    pipeline = None
    async def send_audio(pcm: bytes): await ws.send_bytes(pcm)
    async def send_json(obj: dict): await ws.send_text(json.dumps(obj))
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                if pipeline: await pipeline.feed_audio(msg["bytes"])
                continue
            if msg.get("text") is None:
                continue
            data = json.loads(msg["text"])
            if data.get("type") == "start":
                pipeline = NovaSonicPipeline(session_id, data.get("language", "en_US"), send_audio, send_json)
                await pipeline.start()
            elif data.get("type") == "stop":
                break
    except WebSocketDisconnect:
        pass
    except Exception as e:
        import traceback; print(f"[ws-nova] EXCEPTION: {e}", flush=True); traceback.print_exc()
    finally:
        if pipeline: await pipeline.stop()
