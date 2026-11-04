"""
FastAPI Entrypoint for Servant Peer Node.
Initializes identity, mutual authentication, AES session management,
and mounts REST & WebSocket routers.
"""
import asyncio
import logging
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

# Ensure project root is in python path
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from peer_node.config import NODE_ID, PORT, HOST, CA_URL, PROXY_URL, DATA_DIR
from peer_node.core.identity import IdentityManager
from peer_node.core.handshake import HandshakeManager
from peer_node.core.session import SessionManager
from peer_node.core.peer_discovery import PeerDiscovery
from peer_node.api.routes_peer import router as peer_router
from peer_node.api.routes_control import router as control_router
from peer_node.api.routes_ws import router as ws_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(f"peer_node.{NODE_ID}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Bootstrap peer identity, generate RSA keys, fetch CA Root cert,
    and register with CA server.
    """
    logger.info("[%s] Bootstrapping Peer Node (PORT=%d, CA=%s)...", NODE_ID, PORT, CA_URL)

    # 1. Initialize core managers
    identity = IdentityManager(node_id=NODE_ID, data_dir=DATA_DIR)
    handshake_mgr = HandshakeManager(identity=identity)
    session_mgr = SessionManager(identity=identity)
    discovery = PeerDiscovery(node_id=NODE_ID, ca_url=CA_URL)

    # Save to app state
    app.state.identity = identity
    app.state.handshake_mgr = handshake_mgr
    app.state.session_mgr = session_mgr
    app.state.discovery = discovery
    app.state.proxy_url = PROXY_URL
    app.state.ca_url = CA_URL
    app.state.data_dir = DATA_DIR

    # 2. Asynchronous registration with CA
    async def try_register():
        endpoint = f"http://{NODE_ID}:{PORT}"
        # Retry loop for Docker startup sequencing
        for attempt in range(1, 6):
            try:
                reg_ok = await identity.initialize(ca_url=CA_URL, endpoint=endpoint)
                if reg_ok:
                    logger.info("[%s] Registered with CA successfully on attempt %d", NODE_ID, attempt)
                    await discovery.fetch_peers()
                    return
            except Exception as e:
                logger.warning("[%s] CA registration attempt %d failed: %s", NODE_ID, attempt, e)
            await asyncio.sleep(2)
        logger.warning("[%s] Could not connect to CA after 5 attempts. Operating in offline mode.", NODE_ID)

    # Launch registration in background so server starts promptly
    asyncio.create_task(try_register())

    yield

    logger.info("[%s] Shutting down Peer Node...", NODE_ID)


app = FastAPI(
    title=f"Peer Node [{NODE_ID}]",
    description="Servant Peer Node in Secure P2P Network (§9.1-9.3)",
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

# Mount REST & WS routers
app.include_router(peer_router)
app.include_router(control_router)
app.include_router(ws_router)


@app.get("/health", tags=["Health"])
async def health_check(request: Request):
    """Healthcheck endpoint for Docker and monitoring."""
    identity: IdentityManager = getattr(request.app.state, "identity", None)
    session_mgr: SessionManager = getattr(request.app.state, "session_mgr", None)

    return {
        "status": "healthy",
        "service": "peer_node",
        "node_id": NODE_ID,
        "port": PORT,
        "ca_url": CA_URL,
        "proxy_url": PROXY_URL,
        "is_registered": identity.is_registered if identity else False,
        "ca_trusted": identity.ca_cert is not None if identity else False,
        "active_sessions": len(session_mgr.sessions) if session_mgr else 0,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/", tags=["Root"])
async def root():
    return {
        "message": f"Peer node '{NODE_ID}' is active",
        "node_id": NODE_ID,
        "port": PORT,
        "docs_url": "/docs",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
