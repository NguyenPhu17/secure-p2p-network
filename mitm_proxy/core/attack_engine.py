"""
Attack Engine for MITM Proxy Simulation (§9.1.1).
Simulates 3 fundamental security attacks:
1. Tamper Data: Bit flipping in AES-GCM ciphertext/IV -> triggers INTEGRITY_CHECK_FAILED.
2. Replay Attack: Resending previously captured packets -> triggers REPLAY_ATTACK_DETECTED.
3. Spoof Identity: Swapping X.509 Certificate with untrusted rogue cert -> triggers CERTIFICATE_VERIFICATION_FAILED.
"""
import copy
import json
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, Tuple, Callable, Awaitable
import httpx

from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes

from shared.crypto_utils import (
    b64_encode,
    b64_decode,
    get_utc_timestamp,
    generate_rsa_key_pair,
    cert_to_pem,
    private_key_to_pem,
)
from mitm_proxy.core.packet_store import PacketStore, PacketRecord
from mitm_proxy.core.interceptor import Interceptor

logger = logging.getLogger("mitm_proxy.attack")


def flip_bit_in_base64(b64_str: str, bit_pos: Optional[int] = None) -> Tuple[str, int]:
    """
    Decodes base64 string, flips exactly one bit, and re-encodes to base64.
    If bit_pos is None, defaults to bit 0 of the first byte.
    """
    raw = bytearray(b64_decode(b64_str))
    if len(raw) == 0:
        raise ValueError("Cannot flip bit in empty byte string")

    if bit_pos is None:
        bit_pos = 0

    byte_idx = (bit_pos // 8) % len(raw)
    bit_idx = bit_pos % 8
    raw[byte_idx] ^= (1 << bit_idx)

    return b64_encode(bytes(raw)), bit_pos


def generate_rogue_certificate(
    subject_cn: str = "node_a",
    issuer_cn: str = "ROGUE_CA",
    valid_days: int = 30,
) -> Tuple[str, str]:
    """
    Generate an untrusted self-signed X.509 certificate for identity spoofing.
    Because it is NOT signed by the genuine CA Root, receiver peer verification will fail.
    """
    priv_key, pub_key = generate_rsa_key_pair(2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject_cn)])
    issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, issuer_cn)])

    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(pub_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=valid_days))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(priv_key, hashes.SHA256())
    )
    return cert_to_pem(cert), private_key_to_pem(priv_key)


class AttackEngine:
    def __init__(
        self,
        packet_store: PacketStore,
        interceptor: Interceptor,
        broadcast_func: Optional[Callable[[Dict[str, Any]], Awaitable[None]]] = None,
        http_client: Optional[httpx.AsyncClient] = None,
    ):
        self.packet_store = packet_store
        self.interceptor = interceptor
        self.broadcast_func = broadcast_func
        self._custom_client = http_client
        self._internal_client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._custom_client is not None:
            return self._custom_client
        if self._internal_client is None or self._internal_client.is_closed:
            self._internal_client = httpx.AsyncClient(timeout=15.0)
        return self._internal_client

    async def aclose(self) -> None:
        if self._internal_client and not self._internal_client.is_closed:
            await self._internal_client.aclose()
            self._internal_client = None

    async def _broadcast_event(self, event_data: dict) -> None:
        if self.broadcast_func:
            try:
                await self.broadcast_func(event_data)
            except Exception as e:
                logger.warning("Failed to broadcast attack event: %s", e)

    async def _forward_to_destination(
        self, target_url: str, payload: dict, headers: Optional[dict] = None
    ) -> Tuple[int, Any, dict]:
        for n in ("node_a", "node_b", "node_c"):
            if f"://{n}:" in target_url:
                target_url = target_url.replace(f"://{n}:", f"://peer_{n[-1]}:")
        client = await self._get_client()
        fwd_headers = {"Content-Type": "application/json"}
        if headers:
            for k, v in headers.items():
                if k.lower() not in ("host", "content-length", "x-target-url"):
                    fwd_headers[k] = v

        try:
            res = await client.post(target_url, json=payload, headers=fwd_headers)
            try:
                res_body = res.json()
            except Exception:
                res_body = {"text": res.text}
            return res.status_code, res_body, dict(res.headers)
        except Exception as e:
            logger.error("Attack forward to %s failed: %s", target_url, e)
            return 502, {"status": "ERROR", "error_code": "E_DESTINATION_UNREACHABLE", "detail": str(e)}, {}

    # =========================================================================
    # Attack Scenario 1 — Tamper Data (§9.1.1 & §9.2.1)
    # =========================================================================
    async def tamper_packet(
        self,
        packet_id: Optional[str] = None,
        path: Optional[str] = None,
        bit_position: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Flip 1 bit in ciphertext or iv to trigger GCM auth tag mismatch at receiver.
        """
        # 1. Resolve packet to tamper
        packet: Optional[PacketRecord] = None
        if packet_id:
            packet = self.packet_store.get_packet(packet_id)
        if not packet:
            # Try latest held packet first
            packet = self.packet_store.get_latest_held_packet()
        if not packet:
            # Fall back to latest message or file packet
            packet = self.packet_store.get_latest_packet("SECURE_MESSAGE") or self.packet_store.get_latest_packet("SECURE_FILE") or self.packet_store.get_latest_packet()

        if not packet:
            raise ValueError("No packet found to tamper. Send a message first or put proxy in Hold mode.")

        packet_id = packet.packet_id
        target_url = packet.target_url
        tampered_json = copy.deepcopy(packet.raw_json)

        # 2. Determine JSON path to tamper
        target_path = path
        if not target_path:
            payload_section = tampered_json.get("payload")
            if isinstance(payload_section, dict):
                if "ciphertext" in payload_section:
                    target_path = "payload.ciphertext"
                elif "ciphertext_b64" in payload_section:
                    target_path = "payload.ciphertext_b64"
                elif "iv" in payload_section:
                    target_path = "payload.iv"

        if not target_path:
            target_path = "payload.ciphertext"

        # 3. Apply bit flip
        parts = target_path.split(".")
        current = tampered_json
        for part in parts[:-1]:
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                raise ValueError(f"Invalid path '{target_path}' for packet structure")

        leaf_key = parts[-1]
        if not isinstance(current, dict) or leaf_key not in current:
            raise ValueError(f"Field '{leaf_key}' not found at path '{target_path}'")

        original_val = current[leaf_key]
        if not isinstance(original_val, str):
            raise ValueError(f"Target field '{target_path}' must be a base64 string")

        tampered_val, actual_bit = flip_bit_in_base64(original_val, bit_position)
        current[leaf_key] = tampered_val

        # If packet was already delivered (not HELD), refresh message_id & timestamp
        # so Layer 1 (anti-replay) passes and Layer 2 (tamper detection) is properly evaluated
        if packet.status != "HELD":
            import uuid
            if "message_id" in tampered_json:
                tampered_json["message_id"] = str(uuid.uuid4())
            tampered_json["timestamp"] = get_utc_timestamp()

        # 4. Forward tampered packet to target destination
        status_code, receiver_resp, resp_headers = await self._forward_to_destination(
            target_url, tampered_json, packet.raw_headers
        )

        now_str = get_utc_timestamp()

        # If packet was currently HELD by interceptor, resolve its pending future
        if self.interceptor.is_held(packet_id):
            self.interceptor.resolve_held_packet(packet_id, status_code, receiver_resp, resp_headers)

        # 5. Update packet record
        self.packet_store.update_packet(
            packet_id,
            status="TAMPERED",
            modified_json=tampered_json,
            attack_type="TAMPER_DATA",
            attack_details={
                "path": target_path,
                "bit_position": actual_bit,
                "original_value": original_val[:20] + "..." if len(original_val) > 20 else original_val,
                "tampered_value": tampered_val[:20] + "..." if len(tampered_val) > 20 else tampered_val,
            },
            receiver_response=receiver_resp,
            forwarded_at=now_str,
        )

        # 6. Broadcast ATTACK_RESULT
        attack_result_event = {
            "event": "ATTACK_RESULT",
            "packet_id": packet_id,
            "attack_type": "TAMPER_DATA",
            "forwarded_at": now_str,
            "tamper_info": {
                "path": target_path,
                "bit_position": actual_bit,
            },
            "receiver_response": receiver_resp,
        }
        await self._broadcast_event(attack_result_event)

        logger.info("Executed Tamper Attack on %s -> Receiver returned: %s", packet_id, receiver_resp.get("status") or status_code)
        return {
            "status": "ATTACK_EXECUTED",
            "attack_type": "TAMPER_DATA",
            "packet_id": packet_id,
            "target_url": target_url,
            "tamper_info": {
                "path": target_path,
                "bit_position": actual_bit,
            },
            "receiver_status_code": status_code,
            "receiver_response": receiver_resp,
        }

    # =========================================================================
    # Attack Scenario 2 — Replay Attack (§9.1.1 & §9.3.2)
    # =========================================================================
    async def replay_packet(
        self,
        packet_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Replay a previously captured valid packet to destination.
        Receiver anti-replay layer detects duplicate nonce or message_id and rejects.
        """
        packet: Optional[PacketRecord] = None
        if packet_id:
            packet = self.packet_store.get_packet(packet_id)
        if not packet:
            # Find latest SECURE_MESSAGE or HANDSHAKE_INIT
            packet = (
                self.packet_store.get_latest_packet("SECURE_MESSAGE")
                or self.packet_store.get_latest_packet("SECURE_FILE")
                or self.packet_store.get_latest_packet("HANDSHAKE_INIT")
                or self.packet_store.get_latest_packet()
            )

        if not packet:
            raise ValueError("No packet found in history to replay. Exchange messages first.")

        packet_id = packet.packet_id
        target_url = packet.target_url
        raw_json = packet.raw_json

        # Forward identical packet to target
        status_code, receiver_resp, _ = await self._forward_to_destination(
            target_url, raw_json, packet.raw_headers
        )

        now_str = get_utc_timestamp()

        # Update record (or mark replayed)
        self.packet_store.update_packet(
            packet_id,
            status="REPLAYED",
            attack_type="REPLAY_ATTACK",
            receiver_response=receiver_resp,
            forwarded_at=now_str,
        )

        # Broadcast ATTACK_RESULT
        attack_result_event = {
            "event": "ATTACK_RESULT",
            "packet_id": packet_id,
            "attack_type": "REPLAY_ATTACK",
            "forwarded_at": now_str,
            "receiver_response": receiver_resp,
        }
        await self._broadcast_event(attack_result_event)

        logger.info("Executed Replay Attack on %s -> Receiver returned: %s", packet_id, receiver_resp.get("status") or status_code)
        return {
            "status": "ATTACK_EXECUTED",
            "attack_type": "REPLAY_ATTACK",
            "packet_id": packet_id,
            "target_url": target_url,
            "receiver_status_code": status_code,
            "receiver_response": receiver_resp,
        }

    # =========================================================================
    # Attack Scenario 3 — Spoof Identity (§9.1.1 & §9.2.4)
    # =========================================================================
    async def spoof_identity(
        self,
        packet_id: Optional[str] = None,
        fake_issuer: str = "ROGUE_CA",
        fake_subject: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Replace legitimate certificate in HANDSHAKE_INIT with rogue self-signed certificate.
        Receiver X.509 verification fails because the CA Root public key cannot verify the signature.
        """
        packet: Optional[PacketRecord] = None
        if packet_id:
            packet = self.packet_store.get_packet(packet_id)
        if not packet:
            packet = self.packet_store.get_latest_held_packet()
        if not packet:
            packet = self.packet_store.get_latest_packet("HANDSHAKE_INIT") or self.packet_store.get_latest_packet()

        if not packet:
            raise ValueError("No handshake packet found to spoof. Initiate a handshake first.")

        packet_id = packet.packet_id
        target_url = packet.target_url
        spoofed_json = copy.deepcopy(packet.raw_json)

        subject = fake_subject or spoofed_json.get("from", "node_a")

        # Generate fake self-signed cert
        fake_cert_pem, _ = generate_rogue_certificate(subject_cn=subject, issuer_cn=fake_issuer)

        # Replace certificate_pem in packet
        spoofed_json["certificate_pem"] = fake_cert_pem

        # If packet was already delivered (not HELD), refresh nonce_A & timestamp
        # so replay check passes and certificate signature verification is specifically evaluated
        if packet.status != "HELD":
            from shared.crypto_utils import generate_nonce_b64
            if "nonce_A" in spoofed_json:
                spoofed_json["nonce_A"] = generate_nonce_b64(32)
            spoofed_json["timestamp"] = get_utc_timestamp()

        # Forward spoofed handshake packet to destination
        status_code, receiver_resp, resp_headers = await self._forward_to_destination(
            target_url, spoofed_json, packet.raw_headers
        )

        now_str = get_utc_timestamp()

        # If packet was currently HELD by interceptor, resolve its pending future
        if self.interceptor.is_held(packet_id):
            self.interceptor.resolve_held_packet(packet_id, status_code, receiver_resp, resp_headers)

        # Update packet record
        self.packet_store.update_packet(
            packet_id,
            status="SPOOFED",
            modified_json=spoofed_json,
            attack_type="SPOOF_IDENTITY",
            attack_details={
                "fake_issuer": fake_issuer,
                "fake_subject": subject,
            },
            receiver_response=receiver_resp,
            forwarded_at=now_str,
        )

        # Broadcast ATTACK_RESULT
        attack_result_event = {
            "event": "ATTACK_RESULT",
            "packet_id": packet_id,
            "attack_type": "SPOOF_IDENTITY",
            "forwarded_at": now_str,
            "fake_cert_issuer": fake_issuer,
            "receiver_response": receiver_resp,
        }
        await self._broadcast_event(attack_result_event)

        logger.info("Executed Spoof Identity Attack on %s -> Receiver returned: %s", packet_id, receiver_resp.get("status") or status_code)
        return {
            "status": "ATTACK_EXECUTED",
            "attack_type": "SPOOF_IDENTITY",
            "packet_id": packet_id,
            "target_url": target_url,
            "fake_cert_issuer": fake_issuer,
            "receiver_status_code": status_code,
            "receiver_response": receiver_resp,
        }
