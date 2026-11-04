"""
Unit Tests for Cryptographic Utilities in Peer Node.
Tests §9.2.1 (AES-GCM), §9.2.2 (RSA-OAEP), §9.2.3 (Digital Signatures & Hashing).
"""
import sys
from pathlib import Path

# Add project root to path
BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent
for p in (str(REPO_ROOT), str(BASE_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import pytest
from cryptography.exceptions import InvalidTag

from shared.crypto_utils import (
    generate_rsa_key_pair,
    generate_aes_key,
    generate_nonce,
    generate_nonce_b64,
    b64_encode,
    b64_decode,
    rsa_encrypt_oaep,
    rsa_decrypt_oaep,
    rsa_sign_pss,
    rsa_verify_pss,
    compute_sha256_bytes,
    compute_sha256_b64,
    compute_sha256_hex,
    aes_gcm_encrypt,
    aes_gcm_decrypt,
)


def test_b64_helpers():
    raw = b"Hello Secure P2P Network 2026!"
    encoded = b64_encode(raw)
    assert isinstance(encoded, str)
    decoded = b64_decode(encoded)
    assert decoded == raw


def test_nonce_generation():
    n1 = generate_nonce(32)
    n2 = generate_nonce(32)
    assert len(n1) == 32
    assert len(n2) == 32
    assert n1 != n2

    n_b64 = generate_nonce_b64(32)
    assert len(b64_decode(n_b64)) == 32


def test_rsa_oaep_encrypt_decrypt():
    sk, pk = generate_rsa_key_pair(2048)
    plaintext = b"Secret Nonce or AES Session Key 12345"

    ciphertext = rsa_encrypt_oaep(pk, plaintext)
    assert ciphertext != plaintext

    decrypted = rsa_decrypt_oaep(sk, ciphertext)
    assert decrypted == plaintext

    # Decrypt with wrong private key should fail
    wrong_sk, _ = generate_rsa_key_pair(2048)
    with pytest.raises(Exception):
        rsa_decrypt_oaep(wrong_sk, ciphertext)


def test_rsa_pss_sign_and_verify():
    sk, pk = generate_rsa_key_pair(2048)
    message = b"Authenticated transaction or message payload"

    sig = rsa_sign_pss(sk, message)
    assert len(sig) == 256  # 2048 bits = 256 bytes

    # Valid signature
    assert rsa_verify_pss(pk, sig, message) is True

    # Tampered message
    tampered_msg = b"Authenticated transaction or message payload modified"
    assert rsa_verify_pss(pk, sig, tampered_msg) is False

    # Verification with wrong public key
    _, wrong_pk = generate_rsa_key_pair(2048)
    assert rsa_verify_pss(wrong_pk, sig, message) is False


def test_sha256_computation():
    data = b"Testing SHA-256"
    h_bytes = compute_sha256_bytes(data)
    h_hex = compute_sha256_hex(data)
    h_b64 = compute_sha256_b64(data)

    assert len(h_bytes) == 32
    assert len(h_hex) == 64
    assert h_hex == h_bytes.hex()
    assert b64_decode(h_b64) == h_bytes


def test_aes_gcm_encrypt_decrypt():
    key = generate_aes_key(32)  # 256-bit
    plaintext = b"Top secret P2P message: Hello Bob!"
    aad = b"header_metadata"

    ciphertext, iv, tag = aes_gcm_encrypt(key, plaintext, associated_data=aad)
    assert len(iv) == 12
    assert len(tag) == 16
    assert ciphertext != plaintext

    decrypted = aes_gcm_decrypt(key, iv, ciphertext, tag, associated_data=aad)
    assert decrypted == plaintext


def test_aes_gcm_tamper_detection():
    """Verify that any modification to ciphertext or auth tag raises InvalidTag."""
    key = generate_aes_key(32)
    plaintext = b"Critical financial transfer: $1,000,000"

    ciphertext, iv, tag = aes_gcm_encrypt(key, plaintext)

    # 1. Tamper single byte in ciphertext
    tampered_ct = bytearray(ciphertext)
    tampered_ct[0] ^= 0x01  # flip 1 bit
    with pytest.raises(InvalidTag):
        aes_gcm_decrypt(key, iv, bytes(tampered_ct), tag)

    # 2. Tamper auth tag
    tampered_tag = bytearray(tag)
    tampered_tag[0] ^= 0x01
    with pytest.raises(InvalidTag):
        aes_gcm_decrypt(key, iv, ciphertext, bytes(tampered_tag))

    # 3. Wrong key
    wrong_key = generate_aes_key(32)
    with pytest.raises(InvalidTag):
        aes_gcm_decrypt(wrong_key, iv, ciphertext, tag)

