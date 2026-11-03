from datetime import datetime, timezone
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from config import NODE_ID, PORT, HOST

app = FastAPI(
    title="Certificate Authority & KDC Server",
    description="PKI Root CA for Secure P2P Network (Distributed Systems Project)",
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
        "service": "ca_server",
        "node_id": NODE_ID,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

@app.get("/", tags=["Root"])
async def root():
    return {
        "message": "Certificate Authority (CA/KDC) Server is running",
        "node_id": NODE_ID,
        "docs_url": "/docs"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)

