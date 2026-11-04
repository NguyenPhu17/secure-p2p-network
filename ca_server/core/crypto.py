"""
Cryptographic core for CA / KDC Server.
Provides RSA key management, X.509 Root CA self-signing, and Peer certificate issuance.
Based on Distributed Systems 4th Ed. (§9.2.4).
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Set, List, Tuple, Union

# Ensure shared directory is accessible
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

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
    get_public_key_fingerprint,
    extract_cert_details,
    verify_certificate,
    get_utc_timestamp,
)


def create_ca_root_cert(
    private_key: rsa.RSAPrivateKey,
    ca_name: str = "CA_ROOT",
    org_name: str = "Secure P2P Network CA",
    days_valid: int = 365,
) -> x509.Certificate:
    """
    Generate a self-signed X.509 Root CA Certificate using RSA-SHA256.
    """
    public_key = private_key.public_key()
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, ca_name),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, org_name),
    ])

    now = datetime.now(timezone.utc)
    # 5-minute grace period backward for clock skew
    not_before = now - timedelta(minutes=5)
    not_after = now + timedelta(days=days_valid)

    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(public_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .add_extension(
            x509.BasicConstraints(ca=True, path_length=None),
            critical=True,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(public_key),
            critical=False,
        )
    )

    cert = builder.sign(
        private_key=private_key,
        algorithm=hashes.SHA256(),
    )
    return cert


def issue_peer_cert(
    peer_id: str,
    peer_public_key: Union[rsa.RSAPublicKey, str],
    ca_private_key: rsa.RSAPrivateKey,
    ca_cert: x509.Certificate,
    days_valid: int = 30,
) -> x509.Certificate:
    """
    Issue and sign an X.509 Certificate for a registered Peer Node.
    """
    if isinstance(peer_public_key, str):
        peer_pub_obj = pem_to_public_key(peer_public_key)
    else:
        peer_pub_obj = peer_public_key

    subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, peer_id),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Secure P2P Network Peer"),
    ])

    now = datetime.now(timezone.utc)
    not_before = now - timedelta(minutes=5)
    not_after = now + timedelta(days=days_valid)

    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(peer_pub_obj)
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .add_extension(
            x509.BasicConstraints(ca=False, path_length=None),
            critical=True,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=True,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_cert.public_key()),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(peer_pub_obj),
            critical=False,
        )
    )

    cert = builder.sign(
        private_key=ca_private_key,
        algorithm=hashes.SHA256(),
    )
    return cert

