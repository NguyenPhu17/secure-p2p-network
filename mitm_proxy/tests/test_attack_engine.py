"""
Unit tests for MITM Proxy AttackEngine (§9.1.1).
Tests bit-flipping helpers, rogue certificate generation, and attack orchestration.
"""
import pytest
from mitm_proxy.core.packet_store import PacketStore, PacketRecord
from mitm_proxy.core.interceptor import Interceptor
from mitm_proxy.core.attack_engine import AttackEngine, flip_bit_in_base64, generate_rogue_certificate
from shared.crypto_utils import (
    b64_encode,
    b64_decode,
    generate_rsa_key_pair,
    verify_certificate,
    pem_to_cert,
    cert_to_pem,
)


def test_flip_bit_in_base64():
    original_data = b"Attack At Dawn! AES-256 integrity test"
    b64_orig = b64_encode(original_data)

    # Flip bit 0
    b64_tampered, bit_pos = flip_bit_in_base64(b64_orig, bit_pos=0)
    assert bit_pos == 0
    assert b64_tampered != b64_orig

    tampered_bytes = b64_decode(b64_tampered)
    assert len(tampered_bytes) == len(original_data)
    # The first byte should differ by 1 (bit 0 flipped)
    assert tampered_bytes[0] ^ original_data[0] == 1
    # Remaining bytes identical
    assert tampered_bytes[1:] == original_data[1:]

    # Flip bit 15 (second byte, highest bit: 15 % 8 = 7)
    b64_tampered_15, bit_pos_15 = flip_bit_in_base64(b64_orig, bit_pos=15)
    tampered_bytes_15 = b64_decode(b64_tampered_15)
    assert tampered_bytes_15[1] ^ original_data[1] == (1 << 7)


def test_generate_rogue_certificate():
    cert_pem, priv_key_pem = generate_rogue_certificate(subject_cn="node_a", issuer_cn="MALICIOUS_CA")

    assert "-----BEGIN CERTIFICATE-----" in cert_pem
    assert "-----BEGIN PRIVATE KEY-----" in priv_key_pem

    cert = pem_to_cert(cert_pem)
    # Check Subject and Issuer
    assert "CN=node_a" in cert.subject.rfc4514_string()
    assert "CN=MALICIOUS_CA" in cert.issuer.rfc4514_string()

    # Legitimate CA key
    _, genuine_ca_pub = generate_rsa_key_pair(2048)

    # Verify against genuine CA must fail!
    is_valid, reason = verify_certificate(cert_pem, genuine_ca_pub)
    assert not is_valid
    assert "Certificate verification failed" in reason


@pytest.mark.anyio
async def test_attack_engine_tamper_no_packets():
    store = PacketStore()
    interceptor = Interceptor(packet_store=store)
    engine = AttackEngine(packet_store=store, interceptor=interceptor)

    with pytest.raises(ValueError, match="No packet found to tamper"):
        await engine.tamper_packet()


@pytest.mark.anyio
async def test_attack_engine_replay_no_packets():
    store = PacketStore()
    interceptor = Interceptor(packet_store=store)
    engine = AttackEngine(packet_store=store, interceptor=interceptor)

    with pytest.raises(ValueError, match="No packet found in history to replay"):
        await engine.replay_packet()


@pytest.mark.anyio
async def test_attack_engine_spoof_no_packets():
    store = PacketStore()
    interceptor = Interceptor(packet_store=store)
    engine = AttackEngine(packet_store=store, interceptor=interceptor)

    with pytest.raises(ValueError, match="No handshake packet found to spoof"):
        await engine.spoof_identity()

