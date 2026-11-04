"""
Peer-to-Peer Incoming Protocol Endpoints.
Receives handshake challenges, session keys, encrypted messages, and files.
Performs 3-layer security verification and streams real-time events to the dashboard.
"""
import logging
from pathlib import Path
from typing import Dict, Any
from fastapi import APIRouter, Request, HTTPException, status
from fastapi.responses import JSONResponse

from peer_node.api.routes_ws import ws_manager

logger = logging.getLogger("peer_node.api.peer")

router = APIRouter(tags=["Peer Protocol Endpoints"])


def get_services(request: Request):
    app_state = request.app.state
    identity = getattr(app_state, "identity", None)
    handshake_mgr = getattr(app_state, "handshake_mgr", None)
    session_mgr = getattr(app_state, "session_mgr", None)
    data_dir = getattr(app_state, "data_dir", Path("./data"))

    if not identity or not handshake_mgr or not session_mgr:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Node core services not fully initialized",
        )
    return identity, handshake_mgr, session_mgr, data_dir


@router.post("/handshake/init", summary="Receive Handshake Init (Step 2a -> 2b)")
async def receive_handshake_init(payload: Dict[str, Any], request: Request):
    """
    Responder receives HANDSHAKE_INIT from initiator:
    Verifies initiator's X.509 Certificate with CA, checks nonce_A replay,
    generates nonce_B, encrypts nonce_A with initiator's Public Key (RSA-OAEP),
    and returns HANDSHAKE_RESPOND.
    """
    identity, handshake_mgr, _, _ = get_services(request)

    ok, res, err_code = handshake_mgr.process_handshake_init(payload)

    if not ok:
        await ws_manager.broadcast({
            "event": "SECURITY_ALERT",
            "alert_type": err_code,
            "stage": "HANDSHAKE_INIT",
            "from": payload.get("from"),
            "detail": res.get("detail"),
            "raw_packet": payload,
        })
        return JSONResponse(status_code=400, content=res)

    await ws_manager.broadcast({
        "event": "HANDSHAKE_RESPOND_SENT",
        "peer_id": payload.get("from"),
        "nonce_received": payload.get("nonce_A"),
        "nonce_sent": res.get("nonce_B"),
        "timestamp": res.get("timestamp"),
    })

    return res


@router.post("/handshake/respond", summary="Receive Handshake Respond (Step 2b -> 2c)")
async def receive_handshake_respond(payload: Dict[str, Any], request: Request):
    """
    Initiator receives HANDSHAKE_RESPOND from responder:
    Verifies certificate, decrypts nonce_A, encrypts nonce_B with responder's Public Key,
    and returns HANDSHAKE_CONFIRM.
    """
    identity, handshake_mgr, _, _ = get_services(request)

    ok, res, err_code = handshake_mgr.process_handshake_respond(payload)

    if not ok:
        await ws_manager.broadcast({
            "event": "SECURITY_ALERT",
            "alert_type": err_code,
            "stage": "HANDSHAKE_RESPOND",
            "from": payload.get("from"),
            "detail": res.get("detail"),
            "raw_packet": payload,
        })
        return JSONResponse(status_code=400, content=res)

    await ws_manager.broadcast({
        "event": "HANDSHAKE_CONFIRMED",
        "peer_id": payload.get("from"),
        "status": "AUTH_SUCCESS",
        "timestamp": res.get("timestamp"),
    })

    return res


@router.post("/handshake/confirm", summary="Receive Handshake Confirm (Step 2c)")
async def receive_handshake_confirm(payload: Dict[str, Any], request: Request):
    """
    Responder receives HANDSHAKE_CONFIRM:
    Decrypts nonce_B, checks challenge match, marks mutual authentication AUTH_SUCCESS.
    """
    identity, handshake_mgr, _, _ = get_services(request)

    ok, res, err_code = handshake_mgr.process_handshake_confirm(payload)

    if not ok:
        await ws_manager.broadcast({
            "event": "SECURITY_ALERT",
            "alert_type": err_code,
            "stage": "HANDSHAKE_CONFIRM",
            "from": payload.get("from"),
            "detail": res.get("detail"),
            "raw_packet": payload,
        })
        return JSONResponse(status_code=400, content=res)

    await ws_manager.broadcast({
        "event": "HANDSHAKE_COMPLETED",
        "peer_id": payload.get("from"),
        "status": "AUTH_SUCCESS",
        "timestamp": res.get("timestamp"),
    })

    return res


@router.post("/session/key", summary="Receive Session Key Exchange (Step 3)")
async def receive_session_key(payload: Dict[str, Any], request: Request):
    """
    Receiver gets encrypted AES-256 session key (RSA-OAEP) and verifies RSA-PSS signature.
    """
    identity, handshake_mgr, session_mgr, _ = get_services(request)
    sender_id = payload.get("from")

    # Verify sender has completed mutual authentication
    sender_pk = handshake_mgr.get_peer_public_key(sender_id)
    if not sender_pk:
        detail = f"Peer '{sender_id}' has not completed mutual authentication. Session key rejected."
        await ws_manager.broadcast({
            "event": "SECURITY_ALERT",
            "alert_type": "UNAUTHENTICATED_PEER",
            "from": sender_id,
            "detail": detail,
        })
        return JSONResponse(
            status_code=403,
            content={"status": "ERROR", "error_code": "E_NOT_AUTHENTICATED", "detail": detail},
        )

    ok, res, err_code = session_mgr.process_session_key_exchange(payload, sender_pk)

    if not ok:
        await ws_manager.broadcast({
            "event": "SECURITY_ALERT",
            "alert_type": err_code,
            "stage": "SESSION_KEY_EXCHANGE",
            "from": sender_id,
            "detail": res.get("detail"),
            "raw_packet": payload,
        })
        return JSONResponse(status_code=400, content=res)

    await ws_manager.broadcast({
        "event": "SESSION_ESTABLISHED",
        "peer_id": sender_id,
        "session_id": payload.get("session_id"),
        "timestamp": res.get("timestamp"),
    })

    return res


@router.post("/message", summary="Receive Secure Message (Step 4)")
async def receive_secure_message(payload: Dict[str, Any], request: Request):
    """
    Receiver processes incoming SECURE_MESSAGE through 3-Layer Security:
    - Layer 1: Anti-replay protection (freshness & unique message_id)
    - Layer 2: AES-256-GCM authentication tag check (Tamper detection)
    - Layer 3: SHA-256 hash & RSA-PSS digital signature verification (Non-repudiation)
    """
    identity, handshake_mgr, session_mgr, _ = get_services(request)
    sender_id = payload.get("from")

    sender_pk = handshake_mgr.get_peer_public_key(sender_id)
    if not sender_pk:
        detail = f"Peer '{sender_id}' not authenticated. Message rejected."
        await ws_manager.broadcast({
            "event": "SECURITY_ALERT",
            "alert_type": "UNAUTHENTICATED_PEER",
            "from": sender_id,
            "detail": detail,
        })
        return JSONResponse(
            status_code=403,
            content={"status": "ERROR", "error_code": "E_NOT_AUTHENTICATED", "detail": detail},
        )

    ok, res, err_code = session_mgr.decrypt_and_verify_message(payload, sender_pk)

    if not ok:
        await ws_manager.broadcast({
            "event": "SECURITY_ALERT",
            "alert_type": err_code,
            "stage": "DATA_TRANSFER",
            "from": sender_id,
            "layer_failed": res.get("layer_failed"),
            "detail": res.get("detail"),
            "raw_packet": payload,
        })
        return JSONResponse(status_code=400, content=res)

    await ws_manager.broadcast({
        "event": "MESSAGE_RECEIVED",
        "from": sender_id,
        "message_id": res.get("message_id"),
        "plaintext": res.get("decrypted_plaintext"),
        "verification": res.get("verification"),
        "timestamp": res.get("timestamp"),
    })

    return res


@router.post("/file", summary="Receive Secure File (Step 4b)")
async def receive_secure_file(payload: Dict[str, Any], request: Request):
    """
    Receiver processes incoming SECURE_FILE through 3-Layer Security,
    decrypts file, and persists to local received_files directory.
    """
    identity, handshake_mgr, session_mgr, data_dir = get_services(request)
    sender_id = payload.get("from")

    sender_pk = handshake_mgr.get_peer_public_key(sender_id)
    if not sender_pk:
        return JSONResponse(
            status_code=403,
            content={"status": "ERROR", "error_code": "E_NOT_AUTHENTICATED", "detail": "Peer not authenticated"},
        )

    save_dir = Path(data_dir) / "received_files"
    ok, res, err_code = session_mgr.decrypt_and_verify_file(payload, sender_pk, save_dir)

    if not ok:
        await ws_manager.broadcast({
            "event": "SECURITY_ALERT",
            "alert_type": err_code,
            "stage": "FILE_TRANSFER",
            "from": sender_id,
            "layer_failed": res.get("layer_failed"),
            "detail": res.get("detail"),
        })
        return JSONResponse(status_code=400, content=res)

    await ws_manager.broadcast({
        "event": "FILE_RECEIVED",
        "from": sender_id,
        "filename": res.get("filename"),
        "size_bytes": res.get("size_bytes"),
        "save_path": res.get("save_path"),
        "verification": res.get("verification"),
    })

    return res

