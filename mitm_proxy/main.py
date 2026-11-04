"""
FastAPI Entrypoint for MITM Proxy & Network Inspector (§9.1.1).
Intercepts peer traffic, provides transparent forwarding with Hold/Passthrough modes,
and streams packet inspection and attack simulation events via WebSockets.
"""
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# Ensure project root is in python path
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from fastapi import FastAPI, Request, HTTPException, Response
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from shared.crypto_utils import get_utc_timestamp
from mitm_proxy.config import PORT, HOST, CA_URL
from mitm_proxy.core.packet_store import PacketStore
from mitm_proxy.core.interceptor import Interceptor
from mitm_proxy.core.attack_engine import AttackEngine
from mitm_proxy.api.routes_ws import router as ws_router, ws_manager
from mitm_proxy.api.routes_control import router as control_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("mitm_proxy.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize core services
    packet_store = PacketStore(max_size=500)
    interceptor = Interceptor(
        packet_store=packet_store,
        broadcast_func=ws_manager.broadcast,
        default_mode="passthrough",
        hold_timeout=60.0,
    )
    attack_engine = AttackEngine(
        packet_store=packet_store,
        interceptor=interceptor,
        broadcast_func=ws_manager.broadcast,
    )

    app.state.packet_store = packet_store
    app.state.interceptor = interceptor
    app.state.attack_engine = attack_engine
    app.state.ws_manager = ws_manager

    logger.info("MITM Proxy initialized on port %d (Mode: %s, CA: %s)", PORT, interceptor.mode, CA_URL)
    yield

    # Clean up connections
    await interceptor.aclose()
    await attack_engine.aclose()
    logger.info("MITM Proxy shut down cleanly")


app = FastAPI(
    title="MITM Proxy & Network Inspector",
    description="Man-in-the-middle Intercept & Attack Proxy for Secure P2P Network (§9.1.1)",
    version="1.0.0",
    lifespan=lifespan,
)

# Enable CORS for Frontend Dashboard
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount Routers
app.include_router(control_router)
app.include_router(ws_router)


@app.get("/health", tags=["Health"])
async def health_check(request: Request):
    """Healthcheck endpoint for Docker and monitoring."""
    interceptor = getattr(request.app.state, "interceptor", None)
    packet_store = getattr(request.app.state, "packet_store", None)
    mode = interceptor.mode if interceptor else "passthrough"
    packets_count = packet_store.count() if packet_store else 0
    held_count = interceptor.held_count() if interceptor else 0

    return {
        "status": "healthy",
        "service": "mitm_proxy",
        "port": PORT,
        "ca_url": CA_URL,
        "mode": mode,
        "packets_count": packets_count,
        "held_count": held_count,
        "timestamp": get_utc_timestamp(),
    }


@app.get("/", tags=["Root"])
async def root():
    return {
        "message": "MITM Proxy & Network Inspector is running",
        "port": PORT,
        "docs_url": "/docs",
        "ws_url": "/ws/stream",
    }


@app.post("/forward", summary="Transparent Proxy Forwarder", tags=["Relay"])
async def forward_packet(request: Request):
    """
    Transparent relay forwarding packet to target destination specified in X-Target-URL header.
    In Passthrough mode: captures, inspects, and forwards immediately.
    In Hold mode: captures and queues the packet, awaiting operator attack or release command.
    """
    target_url = request.headers.get("X-Target-URL")
    if not target_url:
        raise HTTPException(status_code=400, detail="Missing X-Target-URL header")

    body = await request.body()
    interceptor: Interceptor = getattr(request.app.state, "interceptor", None)
    if not interceptor:
        raise HTTPException(status_code=500, detail="Interceptor service not initialized")

    status_code, res_content, headers = await interceptor.handle_forward(
        target_url=target_url,
        body_bytes=body,
        headers=dict(request.headers),
    )

    if isinstance(res_content, (dict, list)):
        return JSONResponse(status_code=status_code, content=res_content)
    else:
        return Response(
            content=str(res_content).encode("utf-8") if isinstance(res_content, str) else res_content,
            status_code=status_code,
            media_type=headers.get("content-type", "application/json"),
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
