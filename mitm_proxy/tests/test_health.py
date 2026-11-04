from fastapi.testclient import TestClient
import sys
from pathlib import Path

# Add repo root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from mitm_proxy.main import app

client = TestClient(app)

def test_proxy_health():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "mitm_proxy"
    assert "port" in data

