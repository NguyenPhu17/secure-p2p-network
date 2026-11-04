"""
Identity Management for Peer Node.
Handles RSA-2048 keypair generation, local persistence, CA Root trust bootstrapping,
and X.509 Certificate registration according to §9.2.4.
"""
import logging
from pathlib import Path
from typing import Optional, Dict, Any, Union

import httpx
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import rsa

from shared.crypto_utils import (
    generate_rsa_key_pair,
    private_key_to_pem,
    public_key_to_pem,
    pem_to_private_key,
    pem_to_public_key,
    pem_to_cert,
    cert_to_pem,
    get_public_key_fingerprint,
    extract_cert_details,
    verify_certificate,
    get_utc_timestamp,
)

logger = logging.getLogger("peer_node.identity")


class IdentityManager:
    def __init__(self, node_id: str, data_dir: Union[str, Path]):
        self.node_id = node_id
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

        self.private_key_path = self.data_dir / "private_key.pem"
        self.public_key_path = self.data_dir / "public_key.pem"
        self.cert_path = self.data_dir / "certificate.pem"
        self.ca_cert_path = self.data_dir / "ca_cert.pem"
        self.ca_pubkey_path = self.data_dir / "ca_pubkey.pem"

        self.private_key: Optional[rsa.RSAPrivateKey] = None
        self.public_key: Optional[rsa.RSAPublicKey] = None
        self.public_key_pem: Optional[str] = None
        self.certificate: Optional[x509.Certificate] = None
        self.certificate_pem: Optional[str] = None
        self.cert_details: Optional[Dict[str, Any]] = None

        self.ca_cert: Optional[x509.Certificate] = None
        self.ca_cert_pem: Optional[str] = None
        self.ca_public_key: Optional[rsa.RSAPublicKey] = None
        self.ca_public_key_pem: Optional[str] = None

        self.is_registered: bool = False

    def load_or_generate_keys(self, key_size: int = 2048) -> None:
        """
        Load RSA key pair from local data dir or generate a new 2048-bit pair.
        """
        if self.private_key_path.exists() and self.public_key_path.exists():
            try:
                sk_pem = self.private_key_path.read_text(encoding="utf-8")
                pk_pem = self.public_key_path.read_text(encoding="utf-8")
                self.private_key = pem_to_private_key(sk_pem)
                self.public_key = pem_to_public_key(pk_pem)
                self.public_key_pem = pk_pem
                logger.info("[%s] Loaded existing RSA-2048 key pair from disk", self.node_id)
            except Exception as e:
                logger.warning("[%s] Failed loading keys from disk: %s. Generating new ones.", self.node_id, e)
                self._generate_and_save_keys(key_size)
        else:
            self._generate_and_save_keys(key_size)

        # Load local cert and CA cert if they exist
        if self.cert_path.exists():
            try:
                cert_pem = self.cert_path.read_text(encoding="utf-8")
                self.certificate = pem_to_cert(cert_pem)
                self.certificate_pem = cert_pem
                self.cert_details = extract_cert_details(self.certificate)
                self.is_registered = True
                logger.info("[%s] Loaded existing certificate from disk", self.node_id)
            except Exception as e:
                logger.warning("[%s] Failed loading cert: %s", self.node_id, e)

        if self.ca_cert_path.exists():
            try:
                ca_cert_pem = self.ca_cert_path.read_text(encoding="utf-8")
                self.ca_cert = pem_to_cert(ca_cert_pem)
                self.ca_cert_pem = ca_cert_pem
                self.ca_public_key = self.ca_cert.public_key()
                self.ca_public_key_pem = public_key_to_pem(self.ca_public_key)
            except Exception as e:
                logger.warning("[%s] Failed loading CA cert: %s", self.node_id, e)

    def _generate_and_save_keys(self, key_size: int = 2048) -> None:
        """Generate new RSA keypair and save to disk."""
        logger.info("[%s] Generating new RSA-%d key pair...", self.node_id, key_size)
        self.private_key, self.public_key = generate_rsa_key_pair(key_size)
        self.public_key_pem = public_key_to_pem(self.public_key)
        self.private_key_path.write_text(private_key_to_pem(self.private_key), encoding="utf-8")
        self.public_key_path.write_text(self.public_key_pem, encoding="utf-8")
        logger.info("[%s] RSA keys saved to %s", self.node_id, self.data_dir)

    async def fetch_ca_certificate(self, ca_url: str, client: Optional[httpx.AsyncClient] = None) -> bool:
        """
        Fetch CA Root Certificate from CA server (/ca-cert) and store in trust store.
        """
        target_url = f"{ca_url.rstrip('/')}/ca-cert"
        try:
            close_client = False
            if client is None:
                client = httpx.AsyncClient(timeout=10.0)
                close_client = True
            try:
                res = await client.get(target_url)
                if res.status_code != 200:
                    logger.error("[%s] CA returned error %d: %s", self.node_id, res.status_code, res.text)
                    return False
                data = res.json()
                ca_cert_pem = data.get("ca_certificate_pem")
                ca_pub_pem = data.get("ca_public_key_pem")

                if not ca_cert_pem:
                    logger.error("[%s] No ca_certificate_pem in response from %s", self.node_id, target_url)
                    return False

                self.ca_cert = pem_to_cert(ca_cert_pem)
                self.ca_cert_pem = ca_cert_pem
                self.ca_public_key = pem_to_public_key(ca_pub_pem) if ca_pub_pem else self.ca_cert.public_key()
                self.ca_public_key_pem = public_key_to_pem(self.ca_public_key)

                # Persist CA trust store
                self.ca_cert_path.write_text(ca_cert_pem, encoding="utf-8")
                self.ca_pubkey_path.write_text(self.ca_public_key_pem, encoding="utf-8")
                logger.info("[%s] Successfully bootstrapped CA Root trust from %s", self.node_id, ca_url)
                return True
            finally:
                if close_client:
                    await client.aclose()
        except Exception as e:
            logger.error("[%s] Failed to fetch CA certificate from %s: %s", self.node_id, target_url, e)
            return False

    async def register_with_ca(
        self,
        ca_url: str,
        endpoint: Optional[str] = None,
        client: Optional[httpx.AsyncClient] = None,
    ) -> bool:
        """
        Register with CA server (POST /register) and obtain signed X.509 Certificate.
        """
        if not self.public_key_pem:
            self.load_or_generate_keys()

        target_url = f"{ca_url.rstrip('/')}/register"
        payload = {
            "type": "REGISTER_REQUEST",
            "peer_id": self.node_id,
            "public_key_pem": self.public_key_pem,
            "endpoint": endpoint,
            "timestamp": get_utc_timestamp(),
        }

        try:
            close_client = False
            if client is None:
                client = httpx.AsyncClient(timeout=10.0)
                close_client = True
            try:
                res = await client.post(target_url, json=payload)
                if res.status_code != 200:
                    logger.error("[%s] CA registration failed (%d): %s", self.node_id, res.status_code, res.text)
                    return False
                data = res.json()
                cert_pem = data.get("certificate_pem")
                if not cert_pem:
                    logger.error("[%s] CA registration returned no certificate_pem", self.node_id)
                    return False

                self.certificate = pem_to_cert(cert_pem)
                self.certificate_pem = cert_pem
                self.cert_details = data.get("certificate") or extract_cert_details(self.certificate)
                self.is_registered = True

                # Persist certificate
                self.cert_path.write_text(cert_pem, encoding="utf-8")
                logger.info("[%s] Registered with CA, received cert (serial: %s)", self.node_id, self.cert_details.get("serial_number"))
                return True
            finally:
                if close_client:
                    await client.aclose()
        except Exception as e:
            logger.error("[%s] Failed to register with CA at %s: %s", self.node_id, target_url, e)
            return False

    async def initialize(
        self,
        ca_url: str,
        endpoint: Optional[str] = None,
        client: Optional[httpx.AsyncClient] = None,
    ) -> bool:
        """
        Full identity initialization:
        1. Load or generate local keys.
        2. Fetch CA root certificate.
        3. Register with CA to acquire X.509 Certificate.
        """
        self.load_or_generate_keys()
        ca_ok = await self.fetch_ca_certificate(ca_url, client=client)
        if not ca_ok:
            logger.warning("[%s] CA certificate fetch failed. Will retry later.", self.node_id)

        reg_ok = await self.register_with_ca(ca_url, endpoint=endpoint, client=client)
        if not reg_ok:
            logger.warning("[%s] CA registration failed. Will retry later.", self.node_id)

        return self.is_registered

    def verify_peer_certificate(
        self,
        peer_cert_pem: str,
        revoked_serials: Optional[list] = None,
    ) -> tuple[bool, str]:
        """
        Verify peer's X.509 certificate against locally trusted CA public key.
        """
        if not self.ca_public_key:
            return False, "CA Root public key is not loaded into trust store"
        return verify_certificate(
            cert=peer_cert_pem,
            ca_public_key=self.ca_public_key,
            revoked_serials=revoked_serials,
        )

    def get_identity_info(self) -> Dict[str, Any]:
        """
        Return structured identity details for UI and API reporting.
        """
        fp = get_public_key_fingerprint(self.public_key) if self.public_key else None
        return {
            "node_id": self.node_id,
            "is_registered": self.is_registered,
            "public_key_fingerprint": fp,
            "public_key_pem": self.public_key_pem,
            "certificate_pem": self.certificate_pem,
            "certificate": self.cert_details,
            "ca_trusted": self.ca_cert is not None,
            "ca_public_key_pem": self.ca_public_key_pem,
        }

