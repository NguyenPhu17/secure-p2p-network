"""
REST API Control Endpoints for MITM Proxy (§9.1.1).
Exposes endpoints for switching intercept modes and launching attacks:
- POST /attack/mode: Toggle Hold vs Passthrough
- POST /attack/tamper: Bit flip attack on ciphertext / iv
- POST /attack/replay: Replay captured packet
- POST /attack/spoof: Swap X.509 certificate with rogue certificate
- POST /attack/release: Release held packet
- GET /packets: Inspect intercepted packets
"""
import logging
from typing import Optional, Dict, Any
from pydantic import BaseModel, Field
from fastapi import APIRouter, Request, HTTPException, Query, status

from shared.crypto_utils import get_utc_timestamp
from mitm_proxy.api.routes_ws import ws_manager

logger = logging.getLogger("mitm_proxy.api.control")

router = APIRouter(prefix="", tags=["MITM Proxy Control & Attack"])


class ModeRequest(BaseModel):
    mode: str = Field(..., description="'passthrough' or 'hold' (or 'intercept')")


class TamperRequest(BaseModel):
    packet_id: Optional[str] = Field(None, description="Target packet ID. If omitted, uses latest held or encrypted packet.")
    path: Optional[str] = Field(None, description="JSON path to bitflip (default: 'payload.ciphertext')")
    bit_position: Optional[int] = Field(None, description="Bit position to flip (default: bit 0 of first byte)")


class ReplayRequest(BaseModel):
    packet_id: Optional[str] = Field(None, description="Target packet ID to replay. If omitted, uses latest valid packet.")


class SpoofRequest(BaseModel):
    packet_id: Optional[str] = Field(None, description="Target packet ID. If omitted, uses latest held or HANDSHAKE_INIT packet.")
    fake_issuer: Optional[str] = Field("ROGUE_CA", description="Issuer Common Name for rogue certificate")
    fake_subject: Optional[str] = Field(None, description="Subject Common Name for rogue certificate")


class ReleaseRequest(BaseModel):
    packet_id: Optional[str] = Field(None, description="Target packet ID to release. If omitted, releases latest held packet.")


def _get_services(request: Request):
    app_state = request.app.state
    interceptor = getattr(app_state, "interceptor", None)
    packet_store = getattr(app_state, "packet_store", None)
    attack_engine = getattr(app_state, "attack_engine", None)

    if not interceptor or not packet_store or not attack_engine:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="MITM Proxy core services not initialized",
        )
    return interceptor, packet_store, attack_engine


# =============================================================================
# Mode Control Endpoints
# =============================================================================

@router.get("/attack/mode", summary="Get Current Proxy Intercept Mode")
async def get_mode(request: Request):
    interceptor, _, _ = _get_services(request)
    return {
        "status": "ok",
        "mode": interceptor.mode,
        "held_count": interceptor.held_count(),
    }


@router.post("/attack/mode", summary="Set Proxy Mode (Passthrough vs Hold)")
async def set_mode(payload: ModeRequest, request: Request):
    interceptor, _, _ = _get_services(request)
    try:
        new_mode = interceptor.set_mode(payload.mode)
        await ws_manager.broadcast({
            "event": "MODE_CHANGED",
            "mode": new_mode,
            "timestamp": get_utc_timestamp(),
        })
        return {
            "status": "ok",
            "mode": new_mode,
            "message": f"Proxy mode switched to '{new_mode}'",
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# =============================================================================
# Attack Simulation Endpoints (§9.1.1)
# =============================================================================

@router.post("/attack/tamper", summary="Launch Tamper Data Attack (Bit flip)")
async def launch_tamper_attack(request: Request, payload: Optional[TamperRequest] = None):
    """
    Kịch bản 1: Lật bit trên trường ciphertext hoặc iv để kiểm tra tính toàn vẹn (AES-GCM tag mismatch).
    """
    _, _, attack_engine = _get_services(request)
    pkt_id = payload.packet_id if payload else None
    path = payload.path if payload else None
    bit_pos = payload.bit_position if payload else None

    try:
        result = await attack_engine.tamper_packet(
            packet_id=pkt_id,
            path=path,
            bit_position=bit_pos,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error executing tamper attack: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/attack/replay", summary="Launch Replay Attack")
async def launch_replay_attack(request: Request, payload: Optional[ReplayRequest] = None):
    """
    Kịch bản 2: Gửi lại gói tin hợp lệ cũ để kiểm tra lớp chống phát lại (Nonce / Timestamp / message_id).
    """
    _, _, attack_engine = _get_services(request)
    pkt_id = payload.packet_id if payload else None

    try:
        result = await attack_engine.replay_packet(packet_id=pkt_id)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error executing replay attack: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/attack/spoof", summary="Launch Spoof Identity Attack")
async def launch_spoof_attack(request: Request, payload: Optional[SpoofRequest] = None):
    """
    Kịch bản 3: Tráo đổi chứng chỉ số hợp lệ bằng chứng chỉ giả mạo (Self-signed / Rogue CA).
    """
    _, _, attack_engine = _get_services(request)
    pkt_id = payload.packet_id if payload else None
    fake_issuer = payload.fake_issuer if payload and payload.fake_issuer else "ROGUE_CA"
    fake_subject = payload.fake_subject if payload else None

    try:
        result = await attack_engine.spoof_identity(
            packet_id=pkt_id,
            fake_issuer=fake_issuer,
            fake_subject=fake_subject,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error executing spoof attack: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/attack/release", summary="Release Held Packet Without Tampering")
async def release_packet(request: Request, payload: Optional[ReleaseRequest] = None):
    """
    Cho phép gói tin đang bị giữ (status=HELD) tiếp tục được chuyển tiếp đến đích bình thường.
    """
    interceptor, _, _ = _get_services(request)
    pkt_id = payload.packet_id if payload else None

    ok, msg, pkt = interceptor.release_held_packet(pkt_id)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)

    released_id = pkt.packet_id if pkt else pkt_id
    await ws_manager.broadcast({
        "event": "PACKET_RELEASED",
        "packet_id": released_id,
        "timestamp": get_utc_timestamp(),
    })

    return {
        "status": "ok",
        "message": msg,
        "packet_id": released_id,
    }


# =============================================================================
# Packet Store Inspection Endpoints
# =============================================================================

@router.get("/packets", summary="List Intercepted Packets")
async def list_packets(
    request: Request,
    status_filter: Optional[str] = Query(None, alias="status", description="Filter by status (HELD, FORWARDED, TAMPERED, REPLAYED, SPOOFED)"),
    packet_type: Optional[str] = Query(None, description="Filter by packet type (e.g. HANDSHAKE_INIT, SECURE_MESSAGE)"),
    limit: int = Query(50, ge=1, le=500, description="Max packets to return"),
):
    _, packet_store, _ = _get_services(request)
    records = packet_store.get_packets(status=status_filter, packet_type=packet_type, limit=limit)
    return {
        "count": len(records),
        "total_in_buffer": packet_store.count(),
        "packets": [p.to_dict() for p in records],
    }


@router.get("/packets/{packet_id}", summary="Get Packet Details by ID")
async def get_packet_details(packet_id: str, request: Request):
    _, packet_store, _ = _get_services(request)
    pkt = packet_store.get_packet(packet_id)
    if not pkt:
        raise HTTPException(status_code=404, detail=f"Packet '{packet_id}' not found in packet store")
    return pkt.to_dict()


@router.delete("/packets", summary="Clear Packet Buffer")
async def clear_packets(request: Request):
    _, packet_store, _ = _get_services(request)
    packet_store.clear()
    await ws_manager.broadcast({
        "event": "PACKETS_CLEARED",
        "timestamp": get_utc_timestamp(),
    })
    return {"status": "ok", "message": "Packet store cleared"}

