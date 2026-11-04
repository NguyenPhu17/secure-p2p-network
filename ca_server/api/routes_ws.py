"""
WebSocket Event Stream for CA Server.
Broadcasts PEER_REGISTERED and CERT_REVOKED events to Dashboard UI and observers.
"""
import json
import logging
from typing import List
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger("ca_server.ws")

router = APIRouter(tags=["WebSocket Events"])


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info("WS client connected. Total clients: %d", len(self.active_connections))

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info("WS client disconnected. Remaining clients: %d", len(self.active_connections))

    async def broadcast(self, message: dict):
        """Broadcast JSON event message to all connected WebSocket clients."""
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception as e:
                logger.warning("Failed to send WS message to client: %s", e)
                disconnected.append(connection)

        for conn in disconnected:
            self.disconnect(conn)


manager = ConnectionManager()


@router.websocket("/events")
async def websocket_events_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint for subscribing to CA server events:
    - PEER_REGISTERED
    - CERT_REVOKED
    """
    await manager.connect(websocket)
    try:
        # Send initial greeting
        await websocket.send_json({
            "event": "CA_CONNECTED",
            "message": "Connected to CA Event Stream",
        })
        while True:
            # Keep connection open and accept any incoming ping/messages
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error("WebSocket exception: %s", e)
        manager.disconnect(websocket)

