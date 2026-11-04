"""
Active Control Routes for Peer Node (CLI & Frontend Dashboard triggers).
Allows user or dashboard to initiate connection, handshake, session establishment,
and secure message/file transmissions.
"""
import logging
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field
from fastapi import APIRouter, Request, HTTPException, status
from fastapi.responses import JSONResponse

from peer_node.api.routes_ws import ws_manager
from peer_node.core.transport import send_peer_packet
from shared.crypto_utils import b64_decode

logger = logging.getLogger("peer_node.api.control")

router = APIRouter(tags=["Node Control & User Actions"])


def get_dependencies(request: Request):
    app_state = request.app.state
    identity = getattr(app_state, "identity", None)
    handshake_mgr = getattr(app_state, "handshake_mgr", None)
    session_mgr = getattr(app_state, "session_mgr", None)
    discovery = getattr(app_state, "discovery", None)
    proxy_url = getattr(app_state, "proxy_url", None)
    ca_url = getattr(app_state, "ca_url", None)

    return identity, handshake_mgr, session_mgr, discovery, proxy_url, ca_url


class ConnectRequest(BaseModel):
    target_peer_id: str = Field(..., description="Target node identifier (e.g. node_b)")
    target_url: Optional[str] = Field(default=None, description="Direct or container URL of target peer")


class SendMessageRequest(BaseModel):
    target_peer_id: str = Field(..., description="Destination peer node ID")
    content: str = Field(..., description="Plaintext message to encrypt and send")
    target_url: Optional[str] = Field(default=None, description="Optional override URL for destination peer")


class SendFileRequest(BaseModel):
    target_peer_id: str = Field(..., description="Destination peer node ID")
    filename: str = Field(..., description="Name of the file to send")
    content_b64: str = Field(..., description="Base64-encoded binary content of the file")
    mime_type: Optional[str] = Field(default="application/octet-stream")
    target_url: Optional[str] = Field(default=None)


@router.post("/connect", summary="Initiate Mutual Authentication & Session Key Exchange")
async def connect_to_peer(req: ConnectRequest, request: Request):
    """
    Automated full-flow connection initiator:
    1. Resolve target peer endpoint.
    2. Step 2a: Send HANDSHAKE_INIT.
    3. Step 2b: Receive HANDSHAKE_RESPOND and verify challenge nonce_A.
    4. Step 2c: Send HANDSHAKE_CONFIRM to complete mutual auth.
    5. Step 3: Generate AES-256 session key, wrap in RSA-OAEP, sign with RSA-PSS,
       and send SESSION_KEY_EXCHANGE.
    """
    identity, handshake_mgr, session_mgr, discovery, proxy_url, _ = get_dependencies(request)
    target_id = req.target_peer_id.strip()

    # 1. Resolve endpoint
    target_url = req.target_url or discovery.get_peer_url(target_id)
    if not target_url:
        raise HTTPException(status_code=400, detail=f"Cannot resolve network endpoint for peer '{target_id}'")

    logger.info("[%s] Starting connection sequence to '%s' at %s (proxy: %s)", identity.node_id, target_id, target_url, proxy_url)

    # 2. Step 2a — Create & send HANDSHAKE_INIT
    try:
        init_pkt = handshake_mgr.create_handshake_init(target_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to create handshake init: {str(e)}")

    await ws_manager.broadcast({
        "event": "HANDSHAKE_INIT_SENT",
        "peer_id": target_id,
        "packet": init_pkt,
    })

    status_code, respond_pkt = await send_peer_packet(
        target_url=f"{target_url.rstrip('/')}/handshake/init",
        payload=init_pkt,
        proxy_url=proxy_url,
    )

    if status_code != 200:
        await ws_manager.broadcast({
            "event": "HANDSHAKE_FAILED",
            "peer_id": target_id,
            "status_code": status_code,
            "response": respond_pkt,
        })
        return JSONResponse(
            status_code=status_code,
            content={"status": "FAILED", "stage": "HANDSHAKE_INIT", "response": respond_pkt},
        )

    # 3. Step 2b (Client side) — Process respond, verify nonce_A & cert, create confirm
    ok_respond, confirm_pkt, err = handshake_mgr.process_handshake_respond(respond_pkt)
    if not ok_respond:
        await ws_manager.broadcast({
            "event": "HANDSHAKE_FAILED",
            "peer_id": target_id,
            "error_code": err,
            "detail": confirm_pkt.get("detail"),
        })
        return JSONResponse(status_code=400, content=confirm_pkt)

    # 4. Step 2c — Send HANDSHAKE_CONFIRM
    status_code, confirm_res = await send_peer_packet(
        target_url=f"{target_url.rstrip('/')}/handshake/confirm",
        payload=confirm_pkt,
        proxy_url=proxy_url,
    )

    if status_code != 200:
        return JSONResponse(
            status_code=status_code,
            content={"status": "FAILED", "stage": "HANDSHAKE_CONFIRM", "response": confirm_res},
        )

    # 5. Step 3 — Session Key Exchange (AES-256-GCM session key)
    target_pk = handshake_mgr.get_peer_public_key(target_id)
    if not target_pk:
        raise HTTPException(status_code=500, detail=f"No public key available for authenticated peer '{target_id}'")

    exchange_pkt = session_mgr.create_session_key_exchange(target_id, target_pk)

    await ws_manager.broadcast({
        "event": "SESSION_EXCHANGE_SENT",
        "peer_id": target_id,
        "session_id": exchange_pkt["session_id"],
        "packet": exchange_pkt,
    })

    status_code, session_res = await send_peer_packet(
        target_url=f"{target_url.rstrip('/')}/session/key",
        payload=exchange_pkt,
        proxy_url=proxy_url,
    )

    if status_code != 200:
        return JSONResponse(
            status_code=status_code,
            content={"status": "FAILED", "stage": "SESSION_KEY_EXCHANGE", "response": session_res},
        )

    await ws_manager.broadcast({
        "event": "CONNECTION_ESTABLISHED",
        "peer_id": target_id,
        "session_id": exchange_pkt["session_id"],
        "handshake": "AUTH_SUCCESS",
    })

    return {
        "status": "SUCCESS",
        "peer_id": target_id,
        "session_id": exchange_pkt["session_id"],
        "handshake": "MUTUAL_AUTHENTICATION_VERIFIED",
        "session_key": "AES-256-GCM_ESTABLISHED",
        "target_url": target_url,
    }


@router.post("/send/message", summary="Encrypt and Send Secure Message")
async def send_message(req: SendMessageRequest, request: Request):
    """
    Encrypt plaintext with AES-256-GCM using active session key,
    compute SHA-256 digest, sign with RSA-PSS private key,
    and send SECURE_MESSAGE packet to destination peer via proxy.
    """
    identity, handshake_mgr, session_mgr, discovery, proxy_url, _ = get_dependencies(request)
    target_id = req.target_peer_id.strip()

    # 1. Resolve endpoint
    target_url = req.target_url or discovery.get_peer_url(target_id)
    if not target_url:
        raise HTTPException(status_code=400, detail=f"Cannot resolve network endpoint for peer '{target_id}'")

    # 2. Encrypt message (AES-GCM + SHA-256 + RSA-PSS)
    try:
        msg_pkt = session_mgr.encrypt_message(target_id, req.content)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    await ws_manager.broadcast({
        "event": "MESSAGE_SENT",
        "to": target_id,
        "message_id": msg_pkt["message_id"],
        "plaintext": req.content,
        "packet": msg_pkt,
    })

    # 3. Transmit packet
    status_code, response_data = await send_peer_packet(
        target_url=f"{target_url.rstrip('/')}/message",
        payload=msg_pkt,
        proxy_url=proxy_url,
    )

    return {
        "status_code": status_code,
        "message_id": msg_pkt["message_id"],
        "packet_sent": msg_pkt,
        "receiver_response": response_data,
    }


@router.post("/send/file", summary="Encrypt and Send Secure File")
async def send_file(req: SendFileRequest, request: Request):
    """
    Encrypt file with AES-256-GCM and transmit via SECURE_FILE packet.
    """
    identity, handshake_mgr, session_mgr, discovery, proxy_url, _ = get_dependencies(request)
    target_id = req.target_peer_id.strip()

    target_url = req.target_url or discovery.get_peer_url(target_id)
    if not target_url:
        raise HTTPException(status_code=400, detail=f"Cannot resolve endpoint for peer '{target_id}'")

    try:
        file_bytes = b64_decode(req.content_b64)
        file_pkt = session_mgr.encrypt_file(target_id, req.filename, file_bytes, req.mime_type or "application/octet-stream")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    status_code, response_data = await send_peer_packet(
        target_url=f"{target_url.rstrip('/')}/file",
        payload=file_pkt,
        proxy_url=proxy_url,
    )

    return {
        "status_code": status_code,
        "filename": req.filename,
        "size_bytes": len(file_bytes),
        "message_id": file_pkt["message_id"],
        "receiver_response": response_data,
    }


@router.get("/peers", summary="Get Known & Discovered Peers")
async def get_discovered_peers(request: Request):
    """Return all discovered peers from CA and local cache."""
    _, _, _, discovery, _, _ = get_dependencies(request)
    peers = await discovery.fetch_peers()
    return {
        "total": len(peers),
        "peers": peers,
    }


@router.get("/status", summary="Get Node Security & Identity Status")
async def get_node_status(request: Request):
    """Return identity, certificates, authenticated peers, and active sessions."""
    identity, handshake_mgr, session_mgr, _, proxy_url, ca_url = get_dependencies(request)

    authenticated_peers = list(handshake_mgr.authenticated_peers.keys())
    active_sessions = [
        {
            "session_id": s.session_id,
            "peer_id": s.peer_id,
            "role": s.role,
            "created_at": s.created_at,
            "messages_count": s.messages_count,
        }
        for s in session_mgr.sessions.values()
    ]

    return {
        "identity": identity.get_identity_info(),
        "ca_url": ca_url,
        "proxy_url": proxy_url,
        "authenticated_peers": authenticated_peers,
        "active_sessions": active_sessions,
        "total_messages_exchanged": len(session_mgr.messages_history),
    }


@router.get("/messages", summary="Get Message History & Verification Logs")
async def get_messages_history(request: Request):
    """Return history of inbound and outbound messages with 3-layer verification logs."""
    _, _, session_mgr, _, _, _ = get_dependencies(request)
    return {
        "total": len(session_mgr.messages_history),
        "messages": session_mgr.messages_history,
    }

