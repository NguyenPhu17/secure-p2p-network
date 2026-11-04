"""
WebSocket routes for Peer Node Dashboard.
Streams real-time identity, handshake progression, session keys, and 3-layer decryption logs.
"""
import logging
from typing import List, Dict, Any
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger("peer_node.ws")

router = APIRouter(tags=["Dashboard WebSocket"])


class PeerWebSocketManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info("New dashboard WebSocket client connected (total: %d)", len(self.active_connections))

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info("Dashboard WebSocket client disconnected (remaining: %d)", len(self.active_connections))

    async def broadcast(self, message: Dict[str, Any]):
        """Broadcast event to all connected dashboard clients."""
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception as e:
                logger.warning("Error sending WebSocket message: %s", e)
                self.disconnect(connection)


ws_manager = PeerWebSocketManager()


@router.websocket("/dashboard")
async def websocket_dashboard_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)

    # Send initial state snapshot if available
    try:
        app = websocket.app
        identity = getattr(app.state, "identity", None)
        session_mgr = getattr(app.state, "session_mgr", None)

        if identity:
            await websocket.send_json({
                "event": "IDENTITY_READY",
                "identity": identity.get_identity_info(),
            })

        if session_mgr and session_mgr.messages_history:
            await websocket.send_json({
                "event": "HISTORY_SNAPSHOT",
                "messages": session_mgr.messages_history[-50:],
            })

        while True:
            # Keep connection alive & accept incoming ping/commands
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as e:
        logger.debug("WebSocket connection closed: %s", e)
        ws_manager.disconnect(websocket)

