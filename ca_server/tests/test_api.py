"""
Integration & API Tests for CA Server REST Endpoints & Certificate Store.
"""
import sys
import shutil
import tempfile
from pathlib import Path

# Add project root and ca_server to path
BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent
for p in (str(REPO_ROOT), str(BASE_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import pytest
from fastapi.testclient import TestClient

from shared.crypto_utils import (
    generate_rsa_key_pair,
    public_key_to_pem,
    cert_to_pem,
    verify_certificate,
)
from ca_server.core.certificate_store import CertificateStore
from ca_server.main import app


@pytest.fixture(scope="module", autouse=True)
def setup_ca():
    # Ensure CA store is initialized before tests
    temp_dir = tempfile.mkdtemp(prefix="ca_test_data_")
    store = CertificateStore(data_dir=Path(temp_dir))
    store.initialize(ca_name="CA_ROOT_TEST")
    app.state.cert_store = store

    yield

    shutil.rmtree(temp_dir, ignore_errors=True)


client = TestClient(app)


def test_ca_health():
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "healthy"
    assert data["ca_initialized"] is True


def test_get_ca_cert():
    res = client.get("/ca-cert")
    assert res.status_code == 200
    data = res.json()
    assert "ca_certificate_pem" in data
    assert "ca_public_key_pem" in data
    assert data["ca_name"] == "CA_ROOT"
    assert "-----BEGIN CERTIFICATE-----" in data["ca_certificate_pem"]


def test_register_peer_success():
    _, peer_pk = generate_rsa_key_pair(2048)
    peer_pk_pem = public_key_to_pem(peer_pk)

    res = client.post("/register", json={
        "type": "REGISTER_REQUEST",
        "peer_id": "test_peer_a",
        "public_key_pem": peer_pk_pem,
    })
    assert res.status_code == 200
    data = res.json()
    assert data["type"] == "REGISTER_RESPONSE"
    assert data["peer_id"] == "test_peer_a"
    assert "-----BEGIN CERTIFICATE-----" in data["certificate_pem"]
    assert "certificate" in data
    assert data["certificate"]["subject"] == "test_peer_a"

    # Verify certificate using returned CA pubkey
    is_valid, reason = verify_certificate(data["certificate_pem"], data["ca_public_key_pem"])
    assert is_valid is True, f"Failed verification: {reason}"


def test_register_peer_invalid_pubkey():
    res = client.post("/register", json={
        "type": "REGISTER_REQUEST",
        "peer_id": "invalid_peer",
        "public_key_pem": "NOT_A_VALID_PEM_KEY",
    })
    assert res.status_code == 400
    assert "Registration failed" in res.json()["detail"]


def test_get_peer_certificate():
    # Register peer first
    _, peer_pk = generate_rsa_key_pair(2048)
    peer_pk_pem = public_key_to_pem(peer_pk)
    client.post("/register", json={"peer_id": "test_peer_b", "public_key_pem": peer_pk_pem})

    # Query cert
    res = client.get("/cert/test_peer_b")
    assert res.status_code == 200
    data = res.json()
    assert data["peer_id"] == "test_peer_b"
    assert data["status"] == "ACTIVE"
    assert "-----BEGIN CERTIFICATE-----" in data["certificate_pem"]


def test_get_peer_certificate_not_found():
    res = client.get("/cert/non_existent_node")
    assert res.status_code == 404


def test_peer_discovery_list():
    res = client.get("/peers")
    assert res.status_code == 200
    data = res.json()
    assert "peers" in data
    peer_ids = [p["peer_id"] for p in data["peers"]]
    assert "test_peer_a" in peer_ids
    assert "test_peer_b" in peer_ids


def test_revoke_peer_certificate():
    # Revoke test_peer_b
    res = client.post("/revoke/test_peer_b", json={"reason": "Compromised test key"})
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "revoked"
    assert data["peer_id"] == "test_peer_b"
    assert data["revocation"]["reason"] == "Compromised test key"

    # Check peer cert status is now REVOKED
    cert_res = client.get("/cert/test_peer_b")
    assert cert_res.status_code == 200
    assert cert_res.json()["status"] == "REVOKED"

    # Check CRL endpoint contains the serial
    crl_res = client.get("/crl")
    assert crl_res.status_code == 200
    crl_data = crl_res.json()
    assert crl_data["total_revoked"] >= 1
    revoked_serials = [item["serial_number"].lower() for item in crl_data["revoked_certificates"]]
    assert data["revocation"]["serial_number"].lower() in revoked_serials


def test_revoke_non_existent_peer():
    res = client.post("/revoke/nobody", json={"reason": "test"})
    assert res.status_code == 404


def test_certificate_store_persistence():
    temp_dir = tempfile.mkdtemp(prefix="store_persistence_test_")
    try:
        # Create store 1
        store1 = CertificateStore(data_dir=Path(temp_dir))
        store1.initialize(ca_name="CA_PERSIST_TEST")

        _, pk = generate_rsa_key_pair(2048)
        pk_pem = public_key_to_pem(pk)
        reg_rec = store1.register_peer("peer_persist", pk_pem)
        serial = reg_rec["serial_number"]

        # Revoke it
        store1.revoke_cert("peer_persist", "Persistence test revocation")

        # Now create store 2 pointing to same directory
        store2 = CertificateStore(data_dir=Path(temp_dir))
        store2.initialize(ca_name="CA_PERSIST_TEST")

        # Verify CA cert and keys are identical
        assert cert_to_pem(store1.ca_cert) == cert_to_pem(store2.ca_cert)

        # Verify peer record is restored
        loaded_rec = store2.get_cert("peer_persist")
        assert loaded_rec is not None
        assert loaded_rec["status"] == "REVOKED"
        assert loaded_rec["serial_number"] == serial

        # Verify CRL is restored
        assert store2.is_revoked(serial) is True
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_websocket_connection():
    """Test connecting to WS /events and ping/pong interaction."""
    with client.websocket_connect("/events") as ws:
        greeting = ws.receive_json()
        assert greeting["event"] == "CA_CONNECTED"
        ws.send_text("ping")
        assert ws.receive_text() == "pong"


@pytest.mark.anyio
async def test_websocket_manager_broadcast():
    """Test ConnectionManager broadcast mechanics."""
    from ca_server.api.routes_ws import manager

    class MockWebSocket:
        def __init__(self):
            self.sent = []
        async def send_json(self, data):
            self.sent.append(data)

    mock_ws = MockWebSocket()
    manager.active_connections.append(mock_ws)
    try:
        test_msg = {"event": "TEST_BROADCAST", "payload": "sample"}
        await manager.broadcast(test_msg)
        assert len(mock_ws.sent) == 1
        assert mock_ws.sent[0]["event"] == "TEST_BROADCAST"
    finally:
        if mock_ws in manager.active_connections:
            manager.active_connections.remove(mock_ws)


