from datetime import datetime, timezone
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from config import NODE_ID, PORT, HOST, CA_URL, PROXY_URL

app = FastAPI(
    title=f"Peer Node [{NODE_ID}]",
    description="Servant Peer Node in Secure P2P Network",
    version="1.0.0"
)

# Enable CORS for Frontend Dashboard
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health", tags=["Health"])
async def health_check():
    """Healthcheck endpoint for Docker and monitoring."""
    return {
        "status": "healthy",
        "service": "peer_node",
        "node_id": NODE_ID,
        "port": PORT,
        "ca_url": CA_URL,
        "proxy_url": PROXY_URL,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

@app.get("/", tags=["Root"])
async def root():
    return {
        "message": f"Peer node '{NODE_ID}' is active",
        "node_id": NODE_ID,
        "port": PORT,
        "docs_url": "/docs"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)

