"""
Common cryptographic utilities and helpers for Secure P2P Network.
Based on Distributed Systems 4th Ed. (§9.1-9.3).
"""
import hashlib
from datetime import datetime, timezone
from typing import Optional, Set, List, Tuple, Union

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import NameOID


def get_utc_timestamp() -> str:
    """Return standard ISO-8601 UTC timestamp string."""
    return datetime.now(timezone.utc).isoformat()


def generate_rsa_key_pair(key_size: int = 2048) -> Tuple[rsa.RSAPrivateKey, rsa.RSAPublicKey]:
    """Generate RSA private and public key pair (default 2048-bit)."""
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=key_size,
    )
    return private_key, private_key.public_key()


def private_key_to_pem(private_key: rsa.RSAPrivateKey) -> str:
    """Export RSA private key to unencrypted PKCS#8 PEM string."""
    return private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")


def public_key_to_pem(public_key: rsa.RSAPublicKey) -> str:
    """Export RSA public key to SubjectPublicKeyInfo PEM string."""
    return public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")


def pem_to_private_key(pem_data: Union[str, bytes]) -> rsa.RSAPrivateKey:
    """Import RSA private key from PEM string or bytes."""
    if isinstance(pem_data, str):
        pem_bytes = pem_data.encode("utf-8")
    else:
        pem_bytes = pem_data
    key = serialization.load_pem_private_key(pem_bytes, password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ValueError("Provided PEM does not contain an RSA private key")
    return key


def pem_to_public_key(pem_data: Union[str, bytes]) -> rsa.RSAPublicKey:
    """Import RSA public key from PEM string or bytes."""
    if isinstance(pem_data, str):
        pem_bytes = pem_data.encode("utf-8")
    else:
        pem_bytes = pem_data
    key = serialization.load_pem_public_key(pem_bytes)
    if not isinstance(key, rsa.RSAPublicKey):
        raise ValueError("Provided PEM does not contain an RSA public key")
    return key


def cert_to_pem(cert: x509.Certificate) -> str:
    """Export X.509 certificate to PEM string."""
    return cert.public_bytes(serialization.Encoding.PEM).decode("utf-8")


def pem_to_cert(pem_data: Union[str, bytes]) -> x509.Certificate:
    """Import X.509 certificate from PEM string or bytes."""
    if isinstance(pem_data, str):
        pem_bytes = pem_data.encode("utf-8")
    else:
        pem_bytes = pem_data
    return x509.load_pem_x509_certificate(pem_bytes)


def get_public_key_fingerprint(public_key: Union[rsa.RSAPublicKey, str]) -> str:
    """Calculate SHA-256 fingerprint (hex) of an RSA public key."""
    if isinstance(public_key, str):
        public_key = pem_to_public_key(public_key)
    der = public_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return hashlib.sha256(der).hexdigest()


def extract_cert_details(cert: x509.Certificate) -> dict:
    """Extract structured details from an X.509 certificate for JSON serialization."""
    subject_cn = ""
    for attr in cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME):
        subject_cn = attr.value
        break
    if not subject_cn and cert.subject:
        subject_cn = cert.subject.rfc4514_string()

    issuer_cn = ""
    for attr in cert.issuer.get_attributes_for_oid(NameOID.COMMON_NAME):
        issuer_cn = attr.value
        break
    if not issuer_cn and cert.issuer:
        issuer_cn = cert.issuer.rfc4514_string()

    pub_pem = cert.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")

    fingerprint = cert.fingerprint(hashes.SHA256()).hex()

    return {
        "subject": subject_cn,
        "issuer": issuer_cn,
        "serial_number": hex(cert.serial_number),
        "not_before": cert.not_valid_before_utc.isoformat(),
        "not_after": cert.not_valid_after_utc.isoformat(),
        "signature_alg": "RSA-SHA256",
        "public_key_pem": pub_pem,
        "fingerprint_sha256": fingerprint,
    }


def verify_certificate(
    cert: Union[x509.Certificate, str],
    ca_public_key: Union[rsa.RSAPublicKey, str],
    revoked_serials: Optional[Union[Set[str], List[str]]] = None,
) -> Tuple[bool, str]:
    """
    Verify X.509 certificate against CA Root public key:
    1. Check validity period (not_before <= now <= not_after).
    2. Check revocation status against CRL serial numbers.
    3. Verify cryptographic digital signature using CA's public key.
    
    Returns (is_valid: bool, reason: str).
    """
    try:
        if isinstance(cert, str):
            cert_obj = pem_to_cert(cert)
        else:
            cert_obj = cert

        if isinstance(ca_public_key, str):
            ca_pub_obj = pem_to_public_key(ca_public_key)
        else:
            ca_pub_obj = ca_public_key

        # 1. Check validity dates
        now = datetime.now(timezone.utc)
        if now < cert_obj.not_valid_before_utc:
            return False, f"Certificate not yet valid (valid from {cert_obj.not_valid_before_utc.isoformat()})"
        if now > cert_obj.not_valid_after_utc:
            return False, f"Certificate expired (expired at {cert_obj.not_valid_after_utc.isoformat()})"

        # 2. Check revocation
        if revoked_serials:
            serial_hex = hex(cert_obj.serial_number).lower()
            revoked_set = {str(s).lower() for s in revoked_serials}
            if serial_hex in revoked_set or str(cert_obj.serial_number) in revoked_set:
                return False, f"Certificate revoked (serial: {serial_hex})"

        # 3. Verify digital signature
        # X.509 RSA signature verification
        ca_pub_obj.verify(
            cert_obj.signature,
            cert_obj.tbs_certificate_bytes,
            padding.PKCS1v15(),
            cert_obj.signature_hash_algorithm,
        )
        return True, "Certificate is valid and trusted by CA Root"

    except Exception as e:
        return False, f"Certificate verification failed: {str(e)}"
