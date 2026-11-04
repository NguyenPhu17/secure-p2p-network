import logging
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

# Ensure proper module resolution
BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent
for p in (str(REPO_ROOT), str(BASE_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from config import NODE_ID, PORT, HOST, DATA_DIR
from core.certificate_store import CertificateStore
from api import routes_cert, routes_ws

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("ca_server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing CA Server (Node ID: %s, Data Dir: %s)...", NODE_ID, DATA_DIR)
    store = CertificateStore(data_dir=DATA_DIR)
    store.initialize(ca_name=NODE_ID)
    app.state.cert_store = store
    logger.info("CA Server successfully initialized and ready.")
    yield
    logger.info("CA Server shutting down.")


app = FastAPI(
    title="Certificate Authority & KDC Server",
    description="PKI Root CA for Secure P2P Network (Distributed Systems Project - §9.1-9.3)",
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

# Register API routes
app.include_router(routes_cert.router)
app.include_router(routes_ws.router)


@app.get("/health", tags=["Health"])
async def health_check(request: Request):
    """Healthcheck endpoint for Docker and monitoring."""
    store = getattr(request.app.state, "cert_store", None)
    ca_initialized = store is not None and store.ca_cert is not None
    return {
        "status": "healthy",
        "service": "ca_server",
        "node_id": NODE_ID,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "ca_initialized": ca_initialized,
    }


@app.get("/", tags=["Root"])
async def root():
    return {
        "message": "Certificate Authority (CA/KDC) Server is running",
        "node_id": NODE_ID,
        "docs_url": "/docs",
        "endpoints": {
            "register": "POST /register",
            "get_cert": "GET /cert/{peer_id}",
            "ca_cert": "GET /ca-cert",
            "peers": "GET /peers",
            "revoke": "POST /revoke/{peer_id}",
            "crl": "GET /crl",
            "ws_events": "WS /events",
        },
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
