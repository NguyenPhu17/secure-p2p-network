from datetime import datetime, timezone
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from config import PORT, HOST, CA_URL

app = FastAPI(
    title="MITM Proxy & Network Inspector",
    description="Man-in-the-middle Intercept & Attack Proxy for Secure P2P Network",
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
        "service": "mitm_proxy",
        "port": PORT,
        "ca_url": CA_URL,
        "mode": "passthrough",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

@app.get("/", tags=["Root"])
async def root():
    return {
        "message": "MITM Proxy & Relay is running",
        "port": PORT,
        "docs_url": "/docs"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)

