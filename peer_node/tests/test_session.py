"""
Unit Tests for Session Key Exchange and 3-Layer Secure Data Transfer (§9.2.1, §9.2.2, §9.2.3).
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
from peer_node.core.session import SessionManager
from shared.crypto_utils import b64_encode, b64_decode


@pytest.fixture(scope="module")
def ca_setup():
    temp_dir = tempfile.mkdtemp(prefix="ca_test_session_")
    store = CertificateStore(data_dir=Path(temp_dir))
    store.initialize(ca_name="CA_ROOT_TEST")
    ca_app.state.cert_store = store
    yield store
    shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.fixture
async def setup_session_peers(ca_setup):
    temp_a = tempfile.mkdtemp(prefix="peer_a_sess_")
    temp_b = tempfile.mkdtemp(prefix="peer_b_sess_")

    transport = httpx.ASGITransport(app=ca_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testca") as client:
        id_a = IdentityManager("node_a", temp_a)
        await id_a.initialize("http://testca", client=client)

        id_b = IdentityManager("node_b", temp_b)
        await id_b.initialize("http://testca", client=client)

    sess_a = SessionManager(id_a)
    sess_b = SessionManager(id_b)

    yield sess_a, sess_b, id_a, id_b

    shutil.rmtree(temp_a, ignore_errors=True)
    shutil.rmtree(temp_b, ignore_errors=True)


@pytest.mark.anyio
async def test_session_key_exchange_success(setup_session_peers):
    sess_a, sess_b, id_a, id_b = setup_session_peers

    # Node A generates session key for Node B
    exchange_pkt = sess_a.create_session_key_exchange("node_b", id_b.public_key)
    assert exchange_pkt["type"] == "SESSION_KEY_EXCHANGE"
    assert exchange_pkt["from"] == "node_a"
    assert exchange_pkt["to"] == "node_b"

    # Node B processes session key exchange
    ok_b, res_b, err = sess_b.process_session_key_exchange(exchange_pkt, id_a.public_key)
    assert ok_b is True
    assert res_b["status"] == "SESSION_ESTABLISHED"

    # Check both nodes share the same session key
    session_id = exchange_pkt["session_id"]
    s_a = sess_a.get_session(session_id)
    s_b = sess_b.get_session(session_id)

    assert s_a is not None
    assert s_b is not None
    assert s_a.session_key == s_b.session_key


@pytest.mark.anyio
async def test_session_key_tampered_signature(setup_session_peers):
    sess_a, sess_b, id_a, id_b = setup_session_peers

    exchange_pkt = sess_a.create_session_key_exchange("node_b", id_b.public_key)

    # MITM tampers with signature
    sig_bytes = bytearray(b64_decode(exchange_pkt["signature"]))
    sig_bytes[5] ^= 0xAA
    exchange_pkt["signature"] = b64_encode(bytes(sig_bytes))

    ok_b, res_b, err_code = sess_b.process_session_key_exchange(exchange_pkt, id_a.public_key)
    assert ok_b is False
    assert err_code == "SIGNATURE_VERIFICATION_FAILED"


@pytest.mark.anyio
async def test_secure_message_happy_path(setup_session_peers):
    sess_a, sess_b, id_a, id_b = setup_session_peers

    # Setup session
    exchange_pkt = sess_a.create_session_key_exchange("node_b", id_b.public_key)
    sess_b.process_session_key_exchange(exchange_pkt, id_a.public_key)

    # Node A encrypts message
    original_text = "Hello Node B! Distributed Systems Security is working."
    msg_pkt = sess_a.encrypt_message("node_b", original_text)

    assert msg_pkt["type"] == "SECURE_MESSAGE"
    assert msg_pkt["from"] == "node_a"
    assert msg_pkt["to"] == "node_b"

    # Node B decrypts and verifies (3 layers)
    ok, res, err = sess_b.decrypt_and_verify_message(msg_pkt, id_a.public_key)
    assert ok is True
    assert res["status"] == "MESSAGE_RECEIVED"
    assert res["decrypted_plaintext"] == original_text
    assert res["verification"]["layer1_replay"] == "PASSED"
    assert res["verification"]["layer2_gcm"] == "PASSED"
    assert res["verification"]["layer3_signature"] == "PASSED"


@pytest.mark.anyio
async def test_attack_replay_message(setup_session_peers):
    sess_a, sess_b, id_a, id_b = setup_session_peers

    # Setup session
    exchange_pkt = sess_a.create_session_key_exchange("node_b", id_b.public_key)
    sess_b.process_session_key_exchange(exchange_pkt, id_a.public_key)

    msg_pkt = sess_a.encrypt_message("node_b", "First time sending")

    # 1st receipt: SUCCESS
    ok1, _, _ = sess_b.decrypt_and_verify_message(msg_pkt, id_a.public_key)
    assert ok1 is True

    # 2nd receipt (Replay attack): REJECTED AT LAYER 1
    ok2, res2, err2 = sess_b.decrypt_and_verify_message(msg_pkt, id_a.public_key)
    assert ok2 is False
    assert err2 == "REPLAY_ATTACK_DETECTED"
    assert res2["layer_failed"] == 1


@pytest.mark.anyio
async def test_attack_tamper_ciphertext(setup_session_peers):
    sess_a, sess_b, id_a, id_b = setup_session_peers

    exchange_pkt = sess_a.create_session_key_exchange("node_b", id_b.public_key)
    sess_b.process_session_key_exchange(exchange_pkt, id_a.public_key)

    msg_pkt = sess_a.encrypt_message("node_b", "Transfer 1000 USD to Charlie")

    # Attacker flips 1 bit in ciphertext
    ct_bytes = bytearray(b64_decode(msg_pkt["payload"]["ciphertext"]))
    ct_bytes[0] ^= 0x01
    msg_pkt["payload"]["ciphertext"] = b64_encode(bytes(ct_bytes))

    # Node B verification fails at LAYER 2 (GCM Tag Mismatch)
    ok, res, err = sess_b.decrypt_and_verify_message(msg_pkt, id_a.public_key)
    assert ok is False
    assert err == "INTEGRITY_CHECK_FAILED"
    assert res["error_code"] == "E_TAG_MISMATCH"
    assert res["layer_failed"] == 2


@pytest.mark.anyio
async def test_attack_tamper_signature(setup_session_peers):
    sess_a, sess_b, id_a, id_b = setup_session_peers

    exchange_pkt = sess_a.create_session_key_exchange("node_b", id_b.public_key)
    sess_b.process_session_key_exchange(exchange_pkt, id_a.public_key)

    msg_pkt = sess_a.encrypt_message("node_b", "Legitimate message")

    # Attacker corrupts the digital signature
    sig_bytes = bytearray(b64_decode(msg_pkt["integrity"]["signature"]))
    sig_bytes[10] ^= 0xFF
    msg_pkt["integrity"]["signature"] = b64_encode(bytes(sig_bytes))

    # Node B verification fails at LAYER 3 (Signature verification failed)
    ok, res, err = sess_b.decrypt_and_verify_message(msg_pkt, id_a.public_key)
    assert ok is False
    assert err == "SIGNATURE_VERIFICATION_FAILED"
    assert res["layer_failed"] == 3


@pytest.mark.anyio
async def test_secure_file_transfer(setup_session_peers):
    sess_a, sess_b, id_a, id_b = setup_session_peers

    exchange_pkt = sess_a.create_session_key_exchange("node_b", id_b.public_key)
    sess_b.process_session_key_exchange(exchange_pkt, id_a.public_key)

    file_content = b"PDF or binary data: Distributed Systems assignment final report."
    file_pkt = sess_a.encrypt_file("node_b", "report.pdf", file_content, "application/pdf")

    temp_save_dir = tempfile.mkdtemp(prefix="received_files_")
    try:
        ok, res, err = sess_b.decrypt_and_verify_file(file_pkt, id_a.public_key, Path(temp_save_dir))
        assert ok is True
        assert res["status"] == "FILE_RECEIVED"
        assert res["filename"] == "report.pdf"

        saved_file = Path(temp_save_dir) / "report.pdf"
        assert saved_file.exists()
        assert saved_file.read_bytes() == file_content
    finally:
        shutil.rmtree(temp_save_dir, ignore_errors=True)

