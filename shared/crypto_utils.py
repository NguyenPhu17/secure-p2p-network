"""
Common cryptographic utilities and helpers for Secure P2P Network.
Based on Distributed Systems 4th Ed. (§9.1-9.3).
"""
import base64
import hashlib
import os
import secrets
from datetime import datetime, timezone
from typing import Optional, Set, List, Tuple, Union

from cryptography import x509
from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
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


# =============================================================================
# Base64 & Nonce Helpers
# =============================================================================

def b64_encode(data: bytes) -> str:
    """Encode bytes to UTF-8 base64 string."""
    return base64.b64encode(data).decode("utf-8")


def b64_decode(data: Union[str, bytes]) -> bytes:
    """Decode base64 string or bytes to raw bytes."""
    if isinstance(data, str):
        return base64.b64decode(data.encode("utf-8"))
    return base64.b64decode(data)


def generate_nonce(length: int = 32) -> bytes:
    """Generate cryptographically secure random nonce bytes (default 32 bytes)."""
    return secrets.token_bytes(length)


def generate_nonce_b64(length: int = 32) -> str:
    """Generate cryptographically secure random nonce as base64 string."""
    return b64_encode(generate_nonce(length))


# =============================================================================
# Asymmetric RSA-OAEP Encryption & RSA-PSS Signatures (§9.2.2 & §9.2.3)
# =============================================================================

def rsa_encrypt_oaep(public_key: Union[rsa.RSAPublicKey, str], data: bytes) -> bytes:
    """
    Encrypt data using RSA-OAEP with SHA-256 and MGF1.
    Used for wrapping session keys and nonces.
    """
    if isinstance(public_key, str):
        public_key = pem_to_public_key(public_key)
    return public_key.encrypt(
        data,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )


def rsa_decrypt_oaep(private_key: Union[rsa.RSAPrivateKey, str], ciphertext: bytes) -> bytes:
    """
    Decrypt ciphertext using RSA-OAEP with SHA-256 and MGF1.
    """
    if isinstance(private_key, str):
        private_key = pem_to_private_key(private_key)
    return private_key.decrypt(
        ciphertext,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )


def rsa_sign_pss(private_key: Union[rsa.RSAPrivateKey, str], data: bytes) -> bytes:
    """
    Sign arbitrary byte payload using RSA-PSS with SHA-256.
    Provides origin authenticity and non-repudiation.
    """
    if isinstance(private_key, str):
        private_key = pem_to_private_key(private_key)
    return private_key.sign(
        data,
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.MAX_LENGTH,
        ),
        hashes.SHA256(),
    )


def rsa_verify_pss(public_key: Union[rsa.RSAPublicKey, str], signature: bytes, data: bytes) -> bool:
    """
    Verify RSA-PSS signature against byte data using SHA-256.
    Returns True if valid, False if invalid or corrupted.
    """
    try:
        if isinstance(public_key, str):
            public_key = pem_to_public_key(public_key)
        public_key.verify(
            signature,
            data,
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.MAX_LENGTH,
            ),
            hashes.SHA256(),
        )
        return True
    except (InvalidSignature, Exception):
        return False


def compute_sha256_bytes(data: bytes) -> bytes:
    """Compute raw 32-byte SHA-256 digest."""
    return hashlib.sha256(data).digest()


def compute_sha256_b64(data: bytes) -> str:
    """Compute base64-encoded SHA-256 digest."""
    return b64_encode(compute_sha256_bytes(data))


def compute_sha256_hex(data: bytes) -> str:
    """Compute lowercase hexadecimal SHA-256 digest."""
    return hashlib.sha256(data).hexdigest()


# =============================================================================
# Symmetric Cryptosystem: AES-256-GCM (§9.2.1)
# =============================================================================

def generate_aes_key(key_size_bytes: int = 32) -> bytes:
    """Generate 256-bit symmetric key for AES-256 (32 random bytes)."""
    return secrets.token_bytes(key_size_bytes)


def aes_gcm_encrypt(
    key: bytes,
    plaintext: bytes,
    associated_data: Optional[bytes] = None,
) -> Tuple[bytes, bytes, bytes]:
    """
    Encrypt plaintext using AES-256-GCM.
    Returns: (ciphertext: bytes, iv: bytes [12 bytes], auth_tag: bytes [16 bytes]).
    """
    iv = os.urandom(12)
    aesgcm = AESGCM(key)
    ct_with_tag = aesgcm.encrypt(iv, plaintext, associated_data)
    ciphertext = ct_with_tag[:-16]
    tag = ct_with_tag[-16:]
    return ciphertext, iv, tag


def aes_gcm_decrypt(
    key: bytes,
    iv: bytes,
    ciphertext: bytes,
    tag: bytes,
    associated_data: Optional[bytes] = None,
) -> bytes:
    """
    Decrypt ciphertext using AES-256-GCM with authentication tag check.
    Raises InvalidTag if ciphertext, iv, tag, or associated_data was tampered with.
    """
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(iv, ciphertext + tag, associated_data)

