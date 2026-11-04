from datetime import datetime, timezone
import httpx
from fastapi import FastAPI, Request, HTTPException, Response
from fastapi.responses import JSONResponse
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

@app.post("/forward", summary="Transparent Proxy Forwarder", tags=["Relay"])
async def forward_packet(request: Request):
    """
    Transparent relay forwarding packet to target destination specified in X-Target-URL header.
    """
    target_url = request.headers.get("X-Target-URL")
    if not target_url:
        raise HTTPException(status_code=400, detail="Missing X-Target-URL header")

    body = await request.body()
    headers = dict(request.headers)
    headers.pop("host", None)
    headers.pop("content-length", None)

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            res = await client.post(target_url, content=body, headers=headers)
            try:
                return JSONResponse(status_code=res.status_code, content=res.json())
            except Exception:
                return Response(
                    content=res.content,
                    status_code=res.status_code,
                    media_type=res.headers.get("content-type"),
                )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Bad Gateway: Unable to reach {target_url}: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)

