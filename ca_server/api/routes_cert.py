"""
Certificate Authority REST API Routes.
Endpoints for peer registration, certificate retrieval, CRL, revocation, and peer discovery.
"""
from typing import Optional
from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel, Field

from ca_server.api.routes_ws import manager
from ca_server.core.crypto import get_utc_timestamp

router = APIRouter(tags=["Certificates & PKI"])


# Dependency injection from app.state
def get_cert_store(request: Request):
    store = getattr(request.app.state, "cert_store", None)
    if store is None or store.ca_cert is None:
        raise HTTPException(status_code=500, detail="Certificate store not initialized")
    return store


class RegisterRequest(BaseModel):
    type: Optional[str] = "REGISTER_REQUEST"
    peer_id: str = Field(..., description="Unique alphanumeric identifier of the peer")
    public_key_pem: str = Field(..., description="SubjectPublicKeyInfo RSA Public Key in PEM format")
    timestamp: Optional[str] = Field(default_factory=get_utc_timestamp)


class RevokeRequest(BaseModel):
    reason: Optional[str] = Field(default="Key compromised or node decommissioned")


@router.post("/register", summary="Register Peer and Issue X.509 Certificate")
async def register_peer(req: RegisterRequest, store=Depends(get_cert_store)):
    """
    Register a peer node's RSA Public Key and issue a signed X.509 Certificate.
    Broadcasts PEER_REGISTERED event to dashboard WebSocket clients.
    """
    if not req.peer_id.strip():
        raise HTTPException(status_code=400, detail="peer_id cannot be empty")
    if not req.public_key_pem.strip():
        raise HTTPException(status_code=400, detail="public_key_pem cannot be empty")

    try:
        record = store.register_peer(
            peer_id=req.peer_id.strip(),
            public_key_pem=req.public_key_pem.strip(),
        )
        ca_info = store.get_ca_info()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Registration failed: {str(e)}")

    # Broadcast event to WebSocket subscribers
    await manager.broadcast({
        "event": "PEER_REGISTERED",
        "peer_id": record["peer_id"],
        "serial_number": record["serial_number"],
        "registered_at": record["registered_at"],
        "certificate": record["certificate"],
    })

    return {
        "type": "REGISTER_RESPONSE",
        "peer_id": record["peer_id"],
        "certificate": record["certificate"],
        "certificate_pem": record["certificate_pem"],
        "ca_public_key_pem": ca_info["ca_public_key_pem"],
    }


@router.get("/cert/{peer_id}", summary="Lookup Peer Certificate")
async def get_peer_certificate(peer_id: str, store=Depends(get_cert_store)):
    """
    Retrieve X.509 Certificate PEM and details for a given peer_id.
    """
    record = store.get_cert(peer_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Certificate for peer '{peer_id}' not found")
    
    ca_info = store.get_ca_info()
    return {
        "peer_id": peer_id,
        "status": record["status"],
        "registered_at": record["registered_at"],
        "expires_at": record["expires_at"],
        "certificate": record["certificate"],
        "certificate_pem": record["certificate_pem"],
        "ca_public_key_pem": ca_info["ca_public_key_pem"],
    }


@router.get("/ca-cert", summary="Get CA Root Certificate & Public Key")
async def get_ca_certificate(store=Depends(get_cert_store)):
    """
    Retrieve CA Root Certificate and Public Key for verifying certificate chains.
    """
    try:
        return store.get_ca_info()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/peers", summary="Discover Active Registered Peers")
async def list_peers(store=Depends(get_cert_store)):
    """
    Return list of all registered peers for P2P Discovery.
    """
    peers = store.get_all_peers()
    return {
        "total": len(peers),
        "peers": peers,
    }


@router.post("/revoke/{peer_id}", summary="Revoke Peer Certificate")
async def revoke_peer_certificate(
    peer_id: str,
    req: Optional[RevokeRequest] = None,
    store=Depends(get_cert_store),
):
    """
    Revoke a peer's certificate and add its serial number to the CRL.
    Broadcasts CERT_REVOKED event to dashboard WebSocket clients.
    """
    reason = req.reason if req and req.reason else "Key compromised or node decommissioned"
    try:
        revocation_entry = store.revoke_cert(peer_id=peer_id, reason=reason)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Broadcast event
    await manager.broadcast({
        "event": "CERT_REVOKED",
        "peer_id": peer_id,
        "serial_number": revocation_entry["serial_number"],
        "revoked_at": revocation_entry["revoked_at"],
        "reason": reason,
    })

    return {
        "status": "revoked",
        "peer_id": peer_id,
        "revocation": revocation_entry,
    }


@router.get("/crl", summary="Get Certificate Revocation List")
async def get_crl(store=Depends(get_cert_store)):
    """
    Retrieve Certificate Revocation List (CRL) containing revoked certificate serial numbers.
    """
    crl_list = store.get_crl()
    return {
        "issuer": "CA_ROOT",
        "updated_at": get_utc_timestamp(),
        "total_revoked": len(crl_list),
        "revoked_certificates": crl_list,
    }
