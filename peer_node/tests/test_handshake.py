"""
Unit Tests for Mutual Authentication Handshake Protocol (§9.3.2).
Tests 3-step Challenge-Response, Replay prevention, and Certificate verification.
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

from ca_server.main import app as ca_app
from ca_server.core.certificate_store import CertificateStore
from peer_node.core.identity import IdentityManager
from peer_node.core.handshake import HandshakeManager
from shared.crypto_utils import generate_rsa_key_pair, public_key_to_pem, b64_encode, b64_decode


@pytest.fixture(scope="module")
def ca_setup():
    temp_dir = tempfile.mkdtemp(prefix="ca_test_handshake_")
    store = CertificateStore(data_dir=Path(temp_dir))
    store.initialize(ca_name="CA_ROOT_TEST")
    ca_app.state.cert_store = store
    yield store
    shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.fixture
async def peer_nodes(ca_setup):
    temp_a = tempfile.mkdtemp(prefix="peer_a_hs_")
    temp_b = tempfile.mkdtemp(prefix="peer_b_hs_")

    transport = httpx.ASGITransport(app=ca_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testca") as client:
        id_a = IdentityManager("node_a", temp_a)
        await id_a.initialize("http://testca", client=client)

        id_b = IdentityManager("node_b", temp_b)
        await id_b.initialize("http://testca", client=client)

    hs_a = HandshakeManager(id_a)
    hs_b = HandshakeManager(id_b)

    yield hs_a, hs_b

    shutil.rmtree(temp_a, ignore_errors=True)
    shutil.rmtree(temp_b, ignore_errors=True)


@pytest.mark.anyio
async def test_full_mutual_authentication_success(peer_nodes):
    hs_a, hs_b = peer_nodes

    # Step 2a: Node A creates HANDSHAKE_INIT
    init_pkt = hs_a.create_handshake_init("node_b")
    assert init_pkt["type"] == "HANDSHAKE_INIT"
    assert init_pkt["from"] == "node_a"
    assert init_pkt["to"] == "node_b"
    assert "nonce_A" in init_pkt

    # Step 2b: Node B processes HANDSHAKE_INIT and produces HANDSHAKE_RESPOND
    ok_b, respond_pkt, err_b = hs_b.process_handshake_init(init_pkt)
    assert ok_b is True
    assert respond_pkt["type"] == "HANDSHAKE_RESPOND"
    assert respond_pkt["from"] == "node_b"
    assert respond_pkt["to"] == "node_a"
    assert "nonce_B" in respond_pkt
    assert "encrypted_nonce_A" in respond_pkt

    # Step 2b on Initiator: Node A verifies B's response, verifies nonce_A, produces HANDSHAKE_CONFIRM
    ok_a, confirm_pkt, err_a = hs_a.process_handshake_respond(respond_pkt)
    assert ok_a is True
    assert confirm_pkt["type"] == "HANDSHAKE_CONFIRM"
    assert confirm_pkt["from"] == "node_a"
    assert confirm_pkt["to"] == "node_b"
    assert "encrypted_nonce_B" in confirm_pkt
    assert hs_a.is_peer_authenticated("node_b") is True

    # Step 2c: Node B processes HANDSHAKE_CONFIRM, verifies nonce_B
    ok_confirm, final_res, err_confirm = hs_b.process_handshake_confirm(confirm_pkt)
    assert ok_confirm is True
    assert final_res["status"] == "AUTH_SUCCESS"
    assert hs_b.is_peer_authenticated("node_a") is True


@pytest.mark.anyio
async def test_handshake_replay_attack_nonce_a(peer_nodes):
    hs_a, hs_b = peer_nodes

    init_pkt = hs_a.create_handshake_init("node_b")

    # First time: OK
    ok1, resp1, _ = hs_b.process_handshake_init(init_pkt)
    assert ok1 is True

    # Attacker replays the exact same init_pkt
    ok2, resp2, err_code = hs_b.process_handshake_init(init_pkt)
    assert ok2 is False
    assert err_code == "REPLAY_ATTACK_DETECTED"
    assert resp2["status"] == "ERROR"


@pytest.mark.anyio
async def test_handshake_spoof_fake_certificate(peer_nodes):
    hs_a, hs_b = peer_nodes

    # Attacker crafts an init packet with a fake self-signed cert
    init_pkt = hs_a.create_handshake_init("node_b")

    # Generate an untrusted fake cert
    from ca_server.core.crypto import create_ca_root_cert
    from shared.crypto_utils import cert_to_pem
    fake_sk, _ = generate_rsa_key_pair(2048)
    fake_cert = create_ca_root_cert(fake_sk, ca_name="MALICIOUS_CA")
    fake_cert_pem = cert_to_pem(fake_cert)

    init_pkt["certificate_pem"] = fake_cert_pem

    # Node B must reject fake cert
    ok, resp, err_code = hs_b.process_handshake_init(init_pkt)
    assert ok is False
    assert err_code == "CERTIFICATE_VERIFICATION_FAILED"
    assert resp["status"] == "ERROR"


@pytest.mark.anyio
async def test_handshake_tampered_challenge(peer_nodes):
    hs_a, hs_b = peer_nodes

    init_pkt = hs_a.create_handshake_init("node_b")
    ok_b, respond_pkt, _ = hs_b.process_handshake_init(init_pkt)
    assert ok_b is True

    # Attacker tampers with encrypted_nonce_A
    enc_bytes = bytearray(b64_decode(respond_pkt["encrypted_nonce_A"]))
    enc_bytes[10] ^= 0x55  # tamper byte
    respond_pkt["encrypted_nonce_A"] = b64_encode(bytes(enc_bytes))

    ok_a, resp_a, err_code = hs_a.process_handshake_respond(respond_pkt)
    assert ok_a is False
    assert err_code == "CHALLENGE_VERIFICATION_FAILED"
    assert hs_a.is_peer_authenticated("node_b") is False
