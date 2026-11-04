"""
Integration Tests for Peer Node REST & WebSocket Endpoints (§9.1-9.3).
Simulates full end-to-end communication between Node A and Node B.
"""
import sys
import shutil
import tempfile
from pathlib import Path

# Add project root and peer_node to path
BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent
for p in (str(REPO_ROOT), str(BASE_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import pytest
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ca_server.main import app as ca_app
from ca_server.core.certificate_store import CertificateStore
from peer_node.core.identity import IdentityManager
from peer_node.core.handshake import HandshakeManager
from peer_node.core.session import SessionManager
from peer_node.core.peer_discovery import PeerDiscovery
from peer_node.api.routes_peer import router as peer_router
from peer_node.api.routes_control import router as control_router
from peer_node.api.routes_ws import router as ws_router
from shared.crypto_utils import b64_encode


def create_peer_app(node_id: str, data_dir: Path, ca_url: str):
    """Factory creating an isolated FastAPI app for a peer node."""
    app = FastAPI(title=f"Peer [{node_id}]")
    identity = IdentityManager(node_id=node_id, data_dir=data_dir)
    handshake_mgr = HandshakeManager(identity=identity)
    session_mgr = SessionManager(identity=identity)
    discovery = PeerDiscovery(node_id=node_id, ca_url=ca_url)

    app.state.identity = identity
    app.state.handshake_mgr = handshake_mgr
    app.state.session_mgr = session_mgr
    app.state.discovery = discovery
    app.state.proxy_url = None
    app.state.ca_url = ca_url
    app.state.data_dir = data_dir

    app.include_router(peer_router)
    app.include_router(control_router)
    app.include_router(ws_router)
    return app


@pytest.fixture(scope="module")
def ca_environment():
    temp_ca = tempfile.mkdtemp(prefix="ca_api_test_")
    store = CertificateStore(data_dir=Path(temp_ca))
    store.initialize(ca_name="CA_ROOT_TEST")
    ca_app.state.cert_store = store
    yield store
    shutil.rmtree(temp_ca, ignore_errors=True)


@pytest.fixture
async def network_environment(ca_environment):
    temp_a = tempfile.mkdtemp(prefix="app_a_")
    temp_b = tempfile.mkdtemp(prefix="app_b_")

    app_a = create_peer_app("node_a", Path(temp_a), ca_url="http://ca_server")
    app_b = create_peer_app("node_b", Path(temp_b), ca_url="http://ca_server")

    # In-memory router routing requests between app_a, app_b, and ca_app
    async def custom_transport(request: httpx.Request):
        url_str = str(request.url)
        if "ca_server" in url_str:
            transport = httpx.ASGITransport(app=ca_app)
        elif "node_b" in url_str or "peer_b" in url_str:
            transport = httpx.ASGITransport(app=app_b)
        elif "node_a" in url_str or "peer_a" in url_str:
            transport = httpx.ASGITransport(app=app_a)
        else:
            raise ValueError(f"Unknown destination host in test: {url_str}")
        return await transport.handle_async_request(request)

    async_client = httpx.AsyncClient(transport=httpx.MockTransport(custom_transport))

    # Bootstrap both nodes with CA
    id_a: IdentityManager = app_a.state.identity
    id_b: IdentityManager = app_b.state.identity

    await id_a.initialize("http://ca_server", endpoint="http://node_a:8001", client=async_client)
    await id_b.initialize("http://ca_server", endpoint="http://node_b:8002", client=async_client)

    yield app_a, app_b, async_client

    await async_client.aclose()
    shutil.rmtree(temp_a, ignore_errors=True)
    shutil.rmtree(temp_b, ignore_errors=True)


@pytest.mark.anyio
async def test_peer_status_and_discovery(network_environment):
    app_a, app_b, client = network_environment

    res_a = await client.get("http://node_a/status")
    assert res_a.status_code == 200
    data_a = res_a.json()
    assert data_a["identity"]["node_id"] == "node_a"
    assert data_a["identity"]["is_registered"] is True
    assert data_a["identity"]["ca_trusted"] is True


@pytest.mark.anyio
async def test_full_e2e_connect_and_message_exchange(network_environment):
    app_a, app_b, client = network_environment

    # Monkey-patch send_peer_packet in routes_control of app_a to use client
    from peer_node.api import routes_control

    original_send = routes_control.send_peer_packet

    async def mock_send(target_url, payload, proxy_url=None, client_unused=None, timeout=10.0):
        res = await client.post(target_url, json=payload)
        try:
            return res.status_code, res.json()
        except Exception:
            return res.status_code, {"text": res.text}

    routes_control.send_peer_packet = mock_send

    try:
        # 1. Node A connects to Node B: Mutual Auth Handshake + Session Key Exchange
        connect_res = await client.post("http://node_a/connect", json={
            "target_peer_id": "node_b",
            "target_url": "http://node_b",
        })

        assert connect_res.status_code == 200
        conn_data = connect_res.json()
        assert conn_data["status"] == "SUCCESS"
        assert conn_data["handshake"] == "MUTUAL_AUTHENTICATION_VERIFIED"
        assert conn_data["session_key"] == "AES-256-GCM_ESTABLISHED"

        # 2. Node A sends encrypted message to Node B
        msg_res = await client.post("http://node_a/send/message", json={
            "target_peer_id": "node_b",
            "content": "Secret message from Node A to Node B",
            "target_url": "http://node_b",
        })

        assert msg_res.status_code == 200
        msg_data = msg_res.json()
        assert msg_data["status_code"] == 200
        receiver_resp = msg_data["receiver_response"]
        assert receiver_resp["status"] == "MESSAGE_RECEIVED"
        assert receiver_resp["decrypted_plaintext"] == "Secret message from Node A to Node B"
        assert receiver_resp["verification"]["layer1_replay"] == "PASSED"
        assert receiver_resp["verification"]["layer2_gcm"] == "PASSED"
        assert receiver_resp["verification"]["layer3_signature"] == "PASSED"

        # 3. Check message history on Node B
        history_b = await client.get("http://node_b/messages")
        assert history_b.status_code == 200
        msgs_b = history_b.json()["messages"]
        assert len(msgs_b) >= 1
        assert msgs_b[-1]["plaintext"] == "Secret message from Node A to Node B"

        # 4. Check message history on Node A
        history_a = await client.get("http://node_a/messages")
        assert history_a.status_code == 200
        msgs_a = history_a.json()["messages"]
        assert len(msgs_a) >= 1

        # 5. Send file from Node A to Node B
        sample_file_b64 = b64_encode(b"Important PDF content for Distributed Systems project.")
        file_res = await client.post("http://node_a/send/file", json={
            "target_peer_id": "node_b",
            "filename": "project.pdf",
            "content_b64": sample_file_b64,
            "mime_type": "application/pdf",
            "target_url": "http://node_b",
        })
        assert file_res.status_code == 200
        assert file_res.json()["receiver_response"]["status"] == "FILE_RECEIVED"

    finally:
        routes_control.send_peer_packet = original_send


@pytest.mark.anyio
async def test_node_b_rejects_tampered_packet(network_environment):
    app_a, app_b, client = network_environment

    from peer_node.api import routes_control
    original_send = routes_control.send_peer_packet

    async def mock_send(target_url, payload, proxy_url=None, client_unused=None, timeout=10.0):
        res = await client.post(target_url, json=payload)
        return res.status_code, res.json()

    routes_control.send_peer_packet = mock_send

    try:
        # Handshake & Session
        await client.post("http://node_a/connect", json={
            "target_peer_id": "node_b",
            "target_url": "http://node_b",
        })

        # Encrypt packet from Node A session
        sess_a: SessionManager = app_a.state.session_mgr
        pkt = sess_a.encrypt_message("node_b", "Transfer $500")

        # Tamper with ciphertext (flip 1 bit)
        from shared.crypto_utils import b64_decode
        ct = bytearray(b64_decode(pkt["payload"]["ciphertext"]))
        ct[0] ^= 0x01
        pkt["payload"]["ciphertext"] = b64_encode(bytes(ct))

        # Direct post to Node B /message
        res = await client.post("http://node_b/message", json=pkt)
        assert res.status_code == 400
        data = res.json()
        assert data["status"] == "INTEGRITY_CHECK_FAILED"
        assert data["error_code"] == "E_TAG_MISMATCH"
        assert data["layer_failed"] == 2

    finally:
        routes_control.send_peer_packet = original_send


@pytest.mark.anyio
async def test_node_b_rejects_replayed_packet(network_environment):
    app_a, app_b, client = network_environment

    from peer_node.api import routes_control
    original_send = routes_control.send_peer_packet

    async def mock_send(target_url, payload, proxy_url=None, client_unused=None, timeout=10.0):
        res = await client.post(target_url, json=payload)
        return res.status_code, res.json()

    routes_control.send_peer_packet = mock_send

    try:
        # Handshake & Session
        await client.post("http://node_a/connect", json={
            "target_peer_id": "node_b",
            "target_url": "http://node_b",
        })

        # Normal message send (1st time)
        sess_a: SessionManager = app_a.state.session_mgr
        pkt = sess_a.encrypt_message("node_b", "One-time action")

        res1 = await client.post("http://node_b/message", json=pkt)
        assert res1.status_code == 200

        # Replay attack (2nd time with exact same message_id)
        res2 = await client.post("http://node_b/message", json=pkt)
        assert res2.status_code == 400
        data2 = res2.json()
        assert data2["status"] == "REPLAY_ATTACK_DETECTED"
        assert data2["error_code"] == "E_REPLAY"
        assert data2["layer_failed"] == 1

    finally:
        routes_control.send_peer_packet = original_send

