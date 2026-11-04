"""
Unit Tests for CA Server Cryptographic Primitives and Certificate Verification.
Covers §9.2.4 (Key Management & Certificates) and §9.2.2 (Asymmetric Cryptosystems).
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Add project root and ca_server to path
BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent
for p in (str(REPO_ROOT), str(BASE_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from shared.crypto_utils import (
    generate_rsa_key_pair,
    private_key_to_pem,
    public_key_to_pem,
    pem_to_private_key,
    pem_to_public_key,
    cert_to_pem,
    pem_to_cert,
    extract_cert_details,
    verify_certificate,
    get_public_key_fingerprint,
)
from ca_server.core.crypto import (
    create_ca_root_cert,
    issue_peer_cert,
)


def test_rsa_key_generation_and_pem_serialization():
    """Test generating 2048-bit RSA keys and round-trip PEM serialization."""
    sk, pk = generate_rsa_key_pair(key_size=2048)
    assert sk.key_size == 2048
    assert pk.key_size == 2048

    sk_pem = private_key_to_pem(sk)
    pk_pem = public_key_to_pem(pk)

    assert "-----BEGIN PRIVATE KEY-----" in sk_pem
    assert "-----BEGIN PUBLIC KEY-----" in pk_pem

    # Reload from PEM
    loaded_sk = pem_to_private_key(sk_pem)
    loaded_pk = pem_to_public_key(pk_pem)

    assert loaded_sk.key_size == 2048
    assert loaded_pk.key_size == 2048

    # Fingerprint check
    fp1 = get_public_key_fingerprint(pk)
    fp2 = get_public_key_fingerprint(pk_pem)
    assert fp1 == fp2
    assert len(fp1) == 64  # SHA-256 hex string


def test_ca_root_self_signed_cert():
    """Test generating CA Root self-signed certificate."""
    ca_sk, ca_pk = generate_rsa_key_pair(2048)
    ca_cert = create_ca_root_cert(ca_sk, ca_name="CA_ROOT", days_valid=365)

    assert ca_cert.issuer == ca_cert.subject
    common_name = ca_cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value
    assert common_name == "CA_ROOT"

    # Self-verification using CA public key
    is_valid, reason = verify_certificate(ca_cert, ca_pk)
    assert is_valid is True
    assert "valid and trusted" in reason


def test_issue_peer_certificate_and_verify():
    """Test issuing an X.509 Certificate for a peer and verifying it against CA Root."""
    # 1. Setup CA
    ca_sk, ca_pk = generate_rsa_key_pair(2048)
    ca_cert = create_ca_root_cert(ca_sk, ca_name="CA_ROOT")

    # 2. Setup Peer Node A
    peer_sk, peer_pk = generate_rsa_key_pair(2048)
    peer_pk_pem = public_key_to_pem(peer_pk)

    # 3. CA issues cert for Node A
    peer_cert = issue_peer_cert(
        peer_id="node_a",
        peer_public_key=peer_pk_pem,
        ca_private_key=ca_sk,
        ca_cert=ca_cert,
        days_valid=30,
    )

    cert_pem = cert_to_pem(peer_cert)
    assert "-----BEGIN CERTIFICATE-----" in cert_pem

    # Check cert details
    details = extract_cert_details(peer_cert)
    assert details["subject"] == "node_a"
    assert details["issuer"] == "CA_ROOT"
    assert details["signature_alg"] == "RSA-SHA256"

    # 4. Verify peer cert with CA public key
    is_valid, reason = verify_certificate(peer_cert, ca_pk)
    assert is_valid is True

    # Also verify using PEM strings
    is_valid_pem, _ = verify_certificate(cert_pem, public_key_to_pem(ca_pk))
    assert is_valid_pem is True


def test_detect_tampered_or_untrusted_certificate():
    """Test that certificate signed by unknown CA or with invalid signature is rejected."""
    # Official CA
    ca_sk, ca_pk = generate_rsa_key_pair(2048)
    ca_cert = create_ca_root_cert(ca_sk, ca_name="OFFICIAL_CA")

    # Rogue / Fake CA
    rogue_sk, rogue_pk = generate_rsa_key_pair(2048)
    rogue_ca_cert = create_ca_root_cert(rogue_sk, ca_name="ROGUE_CA")

    # Peer cert issued by Rogue CA
    peer_sk, peer_pk = generate_rsa_key_pair(2048)
    fake_peer_cert = issue_peer_cert(
        peer_id="node_a",
        peer_public_key=peer_pk,
        ca_private_key=rogue_sk,
        ca_cert=rogue_ca_cert,
    )

    # Verify fake peer cert using Official CA public key -> MUST FAIL
    is_valid, reason = verify_certificate(fake_peer_cert, ca_pk)
    assert is_valid is False
    assert "verification failed" in reason.lower()


def test_detect_revoked_certificate():
    """Test that a revoked certificate serial number is detected and rejected."""
    ca_sk, ca_pk = generate_rsa_key_pair(2048)
    ca_cert = create_ca_root_cert(ca_sk)

    peer_sk, peer_pk = generate_rsa_key_pair(2048)
    peer_cert = issue_peer_cert("node_b", peer_pk, ca_sk, ca_cert)

    serial_hex = hex(peer_cert.serial_number)
    crl_set = {serial_hex}

    is_valid, reason = verify_certificate(peer_cert, ca_pk, revoked_serials=crl_set)
    assert is_valid is False
    assert "revoked" in reason.lower()


def test_detect_expired_certificate():
    """Test that expired certificate is detected and rejected."""
    ca_sk, ca_pk = generate_rsa_key_pair(2048)
    ca_cert = create_ca_root_cert(ca_sk)

    peer_sk, peer_pk = generate_rsa_key_pair(2048)
    now = datetime.now(timezone.utc)

    # Construct an already expired certificate manually
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "expired_node")])
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(peer_pk)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=60))
        .not_valid_after(now - timedelta(days=30))
    )
    expired_cert = builder.sign(private_key=ca_sk, algorithm=hashes.SHA256())

    is_valid, reason = verify_certificate(expired_cert, ca_pk)
    assert is_valid is False
    assert "expired" in reason.lower()

