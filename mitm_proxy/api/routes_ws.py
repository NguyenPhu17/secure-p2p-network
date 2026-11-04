"""
WebSocket Packet Streaming for MITM Proxy Dashboard (§9.1.1).
Fans out real-time packet interception events, attack results,
and network topology states to the Frontend Dashboard.
"""
import asyncio
import json
import logging
from typing import Set, Dict, Any
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from shared.crypto_utils import get_utc_timestamp

logger = logging.getLogger("mitm_proxy.ws")

router = APIRouter(tags=["WebSocket Stream"])


class WebSocketManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self.active_connections.add(websocket)
        logger.info("Dashboard WebSocket client connected (Total: %d)", len(self.active_connections))

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self.active_connections.discard(websocket)
        logger.info("Dashboard WebSocket client disconnected (Remaining: %d)", len(self.active_connections))

    async def broadcast(self, message: Dict[str, Any]) -> None:
        """Broadcast JSON message to all currently connected WebSocket clients."""
        text = json.dumps(message)
        async with self._lock:
            dead_connections = set()
            for ws in list(self.active_connections):
                try:
                    await ws.send_text(text)
                except Exception:
                    dead_connections.add(ws)

            for ws in dead_connections:
                self.active_connections.discard(ws)


ws_manager = WebSocketManager()


async def _handle_stream(websocket: WebSocket):
    await ws_manager.connect(websocket)
    app_state = getattr(websocket.app, "state", None)
    interceptor = getattr(app_state, "interceptor", None) if app_state else None
    packet_store = getattr(app_state, "packet_store", None) if app_state else None

    # Send initial status
    try:
        await websocket.send_json({
            "event": "STREAM_CONNECTED",
            "mode": interceptor.mode if interceptor else "passthrough",
            "packets_count": packet_store.count() if packet_store else 0,
            "held_count": interceptor.held_count() if interceptor else 0,
            "timestamp": get_utc_timestamp(),
        })

        while True:
            # Keep connection alive; accept any heartbeat or ping messages
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("action") == "PING":
                    await websocket.send_json({"event": "PONG", "timestamp": get_utc_timestamp()})
            except Exception:
                pass
    except WebSocketDisconnect:
        await ws_manager.disconnect(websocket)
    except Exception as e:
        logger.debug("WebSocket client connection closed: %s", e)
        await ws_manager.disconnect(websocket)


@router.websocket("/ws/stream")
async def websocket_stream_endpoint(websocket: WebSocket):
    await _handle_stream(websocket)


@router.websocket("/stream")
async def websocket_stream_alias(websocket: WebSocket):
    await _handle_stream(websocket)

