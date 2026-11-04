"""
End-to-End Integration Tests for MITM Proxy & 3 Attack Scenarios (§9.1.1).
Simulates full multi-node network (CA + Node A + Proxy + Node B):
- Handshake & Session Key routing through Proxy
- Scenario 1: Tamper Data (AES-GCM Auth Tag mismatch)
- Scenario 2: Replay Attack (Duplicate message_id / nonce)
- Scenario 3: Spoof Identity (Rogue X.509 Certificate verification failure)
- Hold & Release Interception Workflow
- WebSocket Event Stream verification
"""
import sys
import shutil
import tempfile
from pathlib import Path

# Add project root to sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

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
from peer_node.api.routes_ws import router as peer_ws_router

from mitm_proxy.main import app as proxy_app
from mitm_proxy.core.packet_store import PacketStore
from mitm_proxy.core.interceptor import Interceptor
from mitm_proxy.core.attack_engine import AttackEngine
from mitm_proxy.api.routes_ws import ws_manager as proxy_ws_manager


def create_test_peer_app(node_id: str, data_dir: Path, ca_url: str, proxy_url: str):
    app = FastAPI(title=f"Peer [{node_id}]")
    identity = IdentityManager(node_id=node_id, data_dir=data_dir)
    handshake_mgr = HandshakeManager(identity=identity)
    session_mgr = SessionManager(identity=identity)
    discovery = PeerDiscovery(node_id=node_id, ca_url=ca_url)

    app.state.identity = identity
    app.state.handshake_mgr = handshake_mgr
    app.state.session_mgr = session_mgr
    app.state.discovery = discovery
    app.state.proxy_url = proxy_url
    app.state.ca_url = ca_url
    app.state.data_dir = data_dir

    app.include_router(peer_router)
    app.include_router(control_router)
    app.include_router(peer_ws_router)
    return app


@pytest.fixture
async def full_network_env():
    temp_ca = tempfile.mkdtemp(prefix="ca_env_")
    temp_a = tempfile.mkdtemp(prefix="peer_a_env_")
    temp_b = tempfile.mkdtemp(prefix="peer_b_env_")

    # 1. Setup CA
    ca_store = CertificateStore(data_dir=Path(temp_ca))
    ca_store.initialize(ca_name="CA_ROOT_TEST")
    ca_app.state.cert_store = ca_store

    # 2. Setup Peer Apps
    app_a = create_test_peer_app("node_a", Path(temp_a), ca_url="http://ca_server:8000", proxy_url="http://mitm_proxy:8080")
    app_b = create_test_peer_app("node_b", Path(temp_b), ca_url="http://ca_server:8000", proxy_url="http://mitm_proxy:8080")

    # 3. Setup Proxy
    proxy_store = PacketStore(max_size=500)
    # We will hook up interceptor and attack_engine with unified in-process client
    proxy_app.state.packet_store = proxy_store

    # Unified transport dispatching between ca_app, app_a, app_b, and proxy_app
    async def network_transport(request: httpx.Request):
        url_str = str(request.url)
        if "ca_server" in url_str:
            transport = httpx.ASGITransport(app=ca_app)
        elif "mitm_proxy" in url_str or ":8080" in url_str:
            transport = httpx.ASGITransport(app=proxy_app)
        elif "node_b" in url_str or "peer_b" in url_str or ":8002" in url_str:
            transport = httpx.ASGITransport(app=app_b)
        elif "node_a" in url_str or "peer_a" in url_str or ":8001" in url_str:
            transport = httpx.ASGITransport(app=app_a)
        else:
            raise ValueError(f"Unknown destination host in test: {url_str}")
        return await transport.handle_async_request(request)

    async_client = httpx.AsyncClient(transport=httpx.MockTransport(network_transport), timeout=15.0)

    app_a.state.http_client = async_client
    app_b.state.http_client = async_client

    # Re-initialize Proxy state using this shared async_client
    interceptor = Interceptor(
        packet_store=proxy_store,
        broadcast_func=proxy_ws_manager.broadcast,
        default_mode="passthrough",
        hold_timeout=10.0,
        http_client=async_client,
    )
    attack_engine = AttackEngine(
        packet_store=proxy_store,
        interceptor=interceptor,
        broadcast_func=proxy_ws_manager.broadcast,
        http_client=async_client,
    )
    proxy_app.state.interceptor = interceptor
    proxy_app.state.attack_engine = attack_engine

    # 4. Bootstrap Identity with CA for Node A & B
    id_a: IdentityManager = app_a.state.identity
    id_b: IdentityManager = app_b.state.identity
    await id_a.initialize("http://ca_server:8000", endpoint="http://node_a:8001", client=async_client)
    await id_b.initialize("http://ca_server:8000", endpoint="http://node_b:8002", client=async_client)

    yield {
        "app_a": app_a,
        "app_b": app_b,
        "proxy_app": proxy_app,
        "ca_app": ca_app,
        "client": async_client,
        "proxy_store": proxy_store,
        "interceptor": interceptor,
        "attack_engine": attack_engine,
    }

    await async_client.aclose()
    shutil.rmtree(temp_ca, ignore_errors=True)
    shutil.rmtree(temp_a, ignore_errors=True)
    shutil.rmtree(temp_b, ignore_errors=True)


@pytest.mark.anyio
async def test_full_communication_flow_via_mitm_proxy(full_network_env):
    """
    Test regular communication: Handshake -> Session Key -> Secure Message
    All routed transparently through MITM Proxy.
    """
    env = full_network_env
    app_a = env["app_a"]
    client: httpx.AsyncClient = env["client"]
    proxy_store: PacketStore = env["proxy_store"]

    # Node A initiates connection to Node B through control endpoint
    connect_res = await client.post("http://node_a:8001/connect", json={"target_peer_id": "node_b"})
    assert connect_res.status_code == 200
    connect_data = connect_res.json()
    assert connect_data["status"] == "SUCCESS"
    assert "session_id" in connect_data

    # Node A sends secure message
    msg_res = await client.post("http://node_a:8001/send/message", json={
        "target_peer_id": "node_b",
        "plaintext": "Confidential financial statement 2026",
    })
    assert msg_res.status_code == 200
    assert msg_res.json()["status"] == "DELIVERED"

    # Verify MITM Proxy intercepted all the packets!
    packets = proxy_store.get_packets(limit=50)
    packet_types = [p.packet_type for p in packets]

    assert "HANDSHAKE_INIT" in packet_types
    assert "SESSION_KEY_EXCHANGE" in packet_types
    assert "SECURE_MESSAGE" in packet_types

    msg_pkt = proxy_store.get_latest_packet("SECURE_MESSAGE")
    assert msg_pkt is not None
    assert msg_pkt.direction == "node_a → node_b"
    assert msg_pkt.status == "FORWARDED"


@pytest.mark.anyio
async def test_scenario_1_tamper_data_attack(full_network_env):
    """
    Attack Scenario 1: Bit flip on ciphertext -> Node B detects AES-GCM tag mismatch (INTEGRITY_CHECK_FAILED).
    """
    env = full_network_env
    client: httpx.AsyncClient = env["client"]
    proxy_store: PacketStore = env["proxy_store"]

    # 1. Establish session and send initial message
    await client.post("http://node_a:8001/connect", json={"target_peer_id": "node_b"})
    await client.post("http://node_a:8001/send/message", json={
        "target_peer_id": "node_b",
        "plaintext": "Wire transfer 1,000,000 USD to Account #999",
    })

    # 2. Get captured SECURE_MESSAGE packet
    latest_msg = proxy_store.get_latest_packet("SECURE_MESSAGE")
    assert latest_msg is not None
    original_pkt_id = latest_msg.packet_id

    # 3. Call MITM Proxy Tamper API
    tamper_res = await client.post("http://mitm_proxy:8080/attack/tamper", json={
        "packet_id": original_pkt_id,
        "path": "payload.ciphertext",
        "bit_position": 42,
    })

    assert tamper_res.status_code == 200
    attack_data = tamper_res.json()
    assert attack_data["status"] == "ATTACK_EXECUTED"
    assert attack_data["attack_type"] == "TAMPER_DATA"

    # 4. Verify Receiver (Node B) response:
    # Must reject with HTTP 400, INTEGRITY_CHECK_FAILED, E_TAG_MISMATCH
    assert attack_data["receiver_status_code"] == 400
    receiver_resp = attack_data["receiver_response"]
    assert receiver_resp["status"] == "INTEGRITY_CHECK_FAILED"
    assert receiver_resp["error_code"] == "E_TAG_MISMATCH"
    assert receiver_resp["layer_failed"] == 2
    assert "GCM auth tag mismatch" in receiver_resp["detail"]

    # 5. Verify packet store updated status
    updated_pkt = proxy_store.get_packet(original_pkt_id)
    assert updated_pkt.status == "TAMPERED"
    assert updated_pkt.attack_type == "TAMPER_DATA"


@pytest.mark.anyio
async def test_scenario_2_replay_attack(full_network_env):
    """
    Attack Scenario 2: Resend previously captured message -> Node B detects replay (REPLAY_ATTACK_DETECTED).
    """
    env = full_network_env
    client: httpx.AsyncClient = env["client"]
    proxy_store: PacketStore = env["proxy_store"]

    # 1. Connect & Send message
    await client.post("http://node_a:8001/connect", json={"target_peer_id": "node_b"})
    await client.post("http://node_a:8001/send/message", json={
        "target_peer_id": "node_b",
        "plaintext": "First-time legitimate message",
    })

    latest_msg = proxy_store.get_latest_packet("SECURE_MESSAGE")
    assert latest_msg is not None

    # 2. Call MITM Proxy Replay API
    replay_res = await client.post("http://mitm_proxy:8080/attack/replay", json={
        "packet_id": latest_msg.packet_id,
    })

    assert replay_res.status_code == 200
    replay_data = replay_res.json()
    assert replay_data["status"] == "ATTACK_EXECUTED"
    assert replay_data["attack_type"] == "REPLAY_ATTACK"

    # 3. Verify Receiver (Node B) rejected the replay!
    assert replay_data["receiver_status_code"] == 400
    receiver_resp = replay_data["receiver_response"]
    assert receiver_resp["status"] == "REPLAY_ATTACK_DETECTED"
    assert receiver_resp["error_code"] == "E_REPLAY"
    assert receiver_resp["layer_failed"] == 1
    assert "already seen" in receiver_resp["detail"]


@pytest.mark.anyio
async def test_scenario_3_spoof_identity_attack(full_network_env):
    """
    Attack Scenario 3: Swap certificate with rogue self-signed certificate in HANDSHAKE_INIT.
    Node B rejects with CERTIFICATE_VERIFICATION_FAILED.
    """
    env = full_network_env
    client: httpx.AsyncClient = env["client"]
    proxy_store: PacketStore = env["proxy_store"]

    # 1. Initiate normal handshake to capture a HANDSHAKE_INIT packet
    await client.post("http://node_a:8001/connect", json={"target_peer_id": "node_b"})
    handshake_pkt = proxy_store.get_latest_packet("HANDSHAKE_INIT")
    assert handshake_pkt is not None

    # 2. Call Spoof Identity API on MITM Proxy
    spoof_res = await client.post("http://mitm_proxy:8080/attack/spoof", json={
        "packet_id": handshake_pkt.packet_id,
        "fake_issuer": "ATTACKER_FAKE_CA",
    })

    assert spoof_res.status_code == 200
    spoof_data = spoof_res.json()
    assert spoof_data["status"] == "ATTACK_EXECUTED"
    assert spoof_data["attack_type"] == "SPOOF_IDENTITY"

    # 3. Verify Receiver (Node B) response
    assert spoof_data["receiver_status_code"] == 400
    receiver_resp = spoof_data["receiver_response"]
    assert receiver_resp["error_code"] == "CERTIFICATE_VERIFICATION_FAILED"
    assert "verification failed" in receiver_resp["detail"].lower()


@pytest.mark.anyio
async def test_intercept_hold_and_release_workflow(full_network_env):
    """
    Test Interactive Hold Workflow:
    1. Set mode = hold
    2. Node A sends message -> Proxy holds it (status=HELD)
    3. Operator inspects held packet
    4. Operator releases held packet -> Node B receives and decrypts successfully!
    """
    import asyncio
    env = full_network_env
    client: httpx.AsyncClient = env["client"]
    proxy_store: PacketStore = env["proxy_store"]

    # Connect while in passthrough
    await client.post("http://node_a:8001/connect", json={"target_peer_id": "node_b"})

    # Switch Proxy mode to HOLD
    mode_res = await client.post("http://mitm_proxy:8080/attack/mode", json={"mode": "hold"})
    assert mode_res.status_code == 200
    assert mode_res.json()["mode"] == "hold"

    # Send message from Node A in background task (will hold at Proxy)
    send_task = asyncio.create_task(
        client.post("http://node_a:8001/send/message", json={
            "target_peer_id": "node_b",
            "plaintext": "Message held at operator console",
        })
    )

    # Wait for packet to be held
    await asyncio.sleep(0.08)

    # Check held packets via API
    held_res = await client.get("http://mitm_proxy:8080/packets?status=HELD")
    assert held_res.status_code == 200
    held_data = held_res.json()
    assert held_data["count"] >= 1
    held_pkt_id = held_data["packets"][0]["packet_id"]

    # Release held packet
    rel_res = await client.post("http://mitm_proxy:8080/attack/release", json={"packet_id": held_pkt_id})
    assert rel_res.status_code == 200
    assert rel_res.json()["status"] == "ok"

    # Original send request finishes with 200 DELIVERED
    send_res = await send_task
    assert send_res.status_code == 200
    assert send_res.json()["status"] == "DELIVERED"


def test_websocket_stream_connection():
    """
    Test WebSocket connection to /ws/stream.
    """
    sync_client = TestClient(proxy_app)
    with sync_client.websocket_connect("/ws/stream") as websocket:
        welcome = websocket.receive_json()
        assert welcome["event"] == "STREAM_CONNECTED"
        assert "mode" in welcome
        assert "packets_count" in welcome

        # Send PING
        websocket.send_json({"action": "PING"})
        pong = websocket.receive_json()
        assert pong["event"] == "PONG"
