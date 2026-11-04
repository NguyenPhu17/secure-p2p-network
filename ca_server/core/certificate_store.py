"""
Certificate Store & CRL Management for CA Server.
Handles in-memory lookup and persistent file storage (data/certs.json, data/crl.json).
"""
import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Any

from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import rsa

from ca_server.core.crypto import (
    generate_rsa_key_pair,
    create_ca_root_cert,
    issue_peer_cert,
    private_key_to_pem,
    public_key_to_pem,
    pem_to_private_key,
    pem_to_public_key,
    cert_to_pem,
    pem_to_cert,
    extract_cert_details,
    get_utc_timestamp,
)

logger = logging.getLogger("ca_server.certificate_store")


class CertificateStore:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

        self.ca_key_path = self.data_dir / "ca_private_key.pem"
        self.ca_cert_path = self.data_dir / "ca_cert.pem"
        self.certs_file = self.data_dir / "certs.json"
        self.crl_file = self.data_dir / "crl.json"

        self.lock = threading.Lock()

        self.ca_private_key: Optional[rsa.RSAPrivateKey] = None
        self.ca_cert: Optional[x509.Certificate] = None

        # in-memory structures:
        # peer_id -> cert_record dict
        self.certs_by_peer: Dict[str, dict] = {}
        # serial_hex -> cert_record dict
        self.certs_by_serial: Dict[str, dict] = {}
        # CRL records list
        self.crl: List[dict] = []
        # Set of revoked serial numbers (normalized lower-case hex)
        self.revoked_serials: set[str] = set()

    def initialize(self, ca_name: str = "CA_ROOT", key_size: int = 2048):
        """
        Load or create CA Root credentials, and restore persistent certs and CRL.
        """
        with self.lock:
            # 1. Initialize or load CA Root Keys
            if self.ca_key_path.exists() and self.ca_cert_path.exists():
                logger.info("Loading existing CA Root credentials from %s", self.data_dir)
                key_pem = self.ca_key_path.read_text(encoding="utf-8")
                cert_pem = self.ca_cert_path.read_text(encoding="utf-8")
                self.ca_private_key = pem_to_private_key(key_pem)
                self.ca_cert = pem_to_cert(cert_pem)
            else:
                logger.info("Generating new CA Root RSA-2048 key pair and self-signed cert...")
                self.ca_private_key, ca_pub = generate_rsa_key_pair(key_size=key_size)
                self.ca_cert = create_ca_root_cert(
                    private_key=self.ca_private_key,
                    ca_name=ca_name,
                )
                # Persist to disk
                self.ca_key_path.write_text(private_key_to_pem(self.ca_private_key), encoding="utf-8")
                self.ca_cert_path.write_text(cert_to_pem(self.ca_cert), encoding="utf-8")
                logger.info("CA Root credentials generated and saved to %s", self.data_dir)

            # 2. Load CRL
            if self.crl_file.exists():
                try:
                    crl_data = json.loads(self.crl_file.read_text(encoding="utf-8"))
                    self.crl = crl_data.get("revoked_certificates", [])
                    self.revoked_serials = {item["serial_number"].lower() for item in self.crl}
                except Exception as e:
                    logger.error("Failed to load CRL file: %s", e)
                    self.crl = []
                    self.revoked_serials = set()

            # 3. Load issued certificates
            if self.certs_file.exists():
                try:
                    certs_data = json.loads(self.certs_file.read_text(encoding="utf-8"))
                    for record in certs_data.get("certificates", []):
                        peer_id = record["peer_id"]
                        serial = record["serial_number"].lower()
                        self.certs_by_peer[peer_id] = record
                        self.certs_by_serial[serial] = record
                except Exception as e:
                    logger.error("Failed to load certs file: %s", e)
                    self.certs_by_peer = {}
                    self.certs_by_serial = {}

    def _persist_certs(self):
        """Save certificates store to JSON file."""
        data = {
            "updated_at": get_utc_timestamp(),
            "count": len(self.certs_by_peer),
            "certificates": list(self.certs_by_peer.values()),
        }
        self.certs_file.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _persist_crl(self):
        """Save CRL to JSON file."""
        data = {
            "updated_at": get_utc_timestamp(),
            "issuer": "CA_ROOT",
            "count": len(self.crl),
            "revoked_certificates": self.crl,
        }
        self.crl_file.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def get_ca_info(self) -> dict:
        """Return CA Root certificate info and PEM."""
        if not self.ca_cert or not self.ca_private_key:
            raise RuntimeError("CA Root not initialized")
        ca_pub_pem = public_key_to_pem(self.ca_private_key.public_key())
        ca_cert_pem = cert_to_pem(self.ca_cert)
        return {
            "ca_name": "CA_ROOT",
            "ca_public_key_pem": ca_pub_pem,
            "ca_certificate_pem": ca_cert_pem,
            "details": extract_cert_details(self.ca_cert),
        }

    def register_peer(self, peer_id: str, public_key_pem: str, days_valid: int = 30) -> dict:
        """
        Issue an X.509 Certificate for peer_id, store it, and persist to file.
        """
        with self.lock:
            if not self.ca_cert or not self.ca_private_key:
                raise RuntimeError("CA Root is not initialized")

            # Validate public key PEM
            peer_pub = pem_to_public_key(public_key_pem)

            # Issue cert
            cert = issue_peer_cert(
                peer_id=peer_id,
                peer_public_key=peer_pub,
                ca_private_key=self.ca_private_key,
                ca_cert=self.ca_cert,
                days_valid=days_valid,
            )

            cert_pem = cert_to_pem(cert)
            details = extract_cert_details(cert)
            serial_hex = details["serial_number"]

            record = {
                "peer_id": peer_id,
                "serial_number": serial_hex,
                "status": "ACTIVE",
                "registered_at": get_utc_timestamp(),
                "expires_at": details["not_after"],
                "public_key_pem": public_key_pem.strip(),
                "certificate_pem": cert_pem,
                "certificate": details,
            }

            self.certs_by_peer[peer_id] = record
            self.certs_by_serial[serial_hex.lower()] = record
            self._persist_certs()

            return record

    def get_cert(self, peer_id: str) -> Optional[dict]:
        """Get certificate record for peer_id."""
        with self.lock:
            return self.certs_by_peer.get(peer_id)

    def get_cert_by_serial(self, serial_hex: str) -> Optional[dict]:
        """Get certificate record by serial number (hex string)."""
        with self.lock:
            return self.certs_by_serial.get(serial_hex.lower())

    def get_all_peers(self) -> List[dict]:
        """
        Return list of all registered active/known peers for discovery.
        """
        with self.lock:
            peers = []
            for peer_id, rec in self.certs_by_peer.items():
                peers.append({
                    "peer_id": peer_id,
                    "status": rec.get("status", "ACTIVE"),
                    "serial_number": rec.get("serial_number"),
                    "registered_at": rec.get("registered_at"),
                    "expires_at": rec.get("expires_at"),
                    "fingerprint_sha256": rec.get("certificate", {}).get("fingerprint_sha256", ""),
                })
            return peers

    def revoke_cert(self, peer_id: str, reason: str = "Key compromised") -> dict:
        """
        Revoke certificate for peer_id, add to CRL, update status and persist.
        """
        with self.lock:
            if peer_id not in self.certs_by_peer:
                raise ValueError(f"Peer '{peer_id}' not found in certificate registry")

            rec = self.certs_by_peer[peer_id]
            rec["status"] = "REVOKED"
            serial_hex = rec["serial_number"]

            revocation_entry = {
                "serial_number": serial_hex,
                "peer_id": peer_id,
                "revoked_at": get_utc_timestamp(),
                "reason": reason,
            }

            # Avoid duplicates in CRL
            if serial_hex.lower() not in self.revoked_serials:
                self.crl.append(revocation_entry)
                self.revoked_serials.add(serial_hex.lower())

            self._persist_certs()
            self._persist_crl()

            return revocation_entry

    def get_crl(self) -> List[dict]:
        """Return the current list of revoked certificates."""
        with self.lock:
            return list(self.crl)

    def is_revoked(self, serial_hex: str) -> bool:
        """Check if a certificate serial number is revoked."""
        with self.lock:
            return serial_hex.lower() in self.revoked_serials

