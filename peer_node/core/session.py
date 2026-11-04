"""
Session Key Management & Secure Data Transfer for Peer Nodes.
Implements:
- RSA-OAEP wrapped AES-256 Session Key Exchange with RSA-PSS Signatures (§9.2.2 & §9.2.4).
- AES-256-GCM authenticated encryption for messages and files (§9.2.1).
- 3-Layer Verification on receiver side:
    Layer 1: Anti-replay protection (Message ID & Timestamp checks)
    Layer 2: Symmetric integrity check (AES-GCM Auth Tag)
    Layer 3: Non-repudiation & origin authentication (RSA-PSS Signature over SHA-256)
"""
import logging
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any, Union

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric import rsa

from peer_node.core.identity import IdentityManager
from shared.crypto_utils import (
    generate_aes_key,
    b64_encode,
    b64_decode,
    rsa_encrypt_oaep,
    rsa_decrypt_oaep,
    rsa_sign_pss,
    rsa_verify_pss,
    compute_sha256_bytes,
    compute_sha256_b64,
    aes_gcm_encrypt,
    aes_gcm_decrypt,
    get_utc_timestamp,
)

logger = logging.getLogger("peer_node.session")

MAX_MESSAGE_CLOCK_SKEW_SECONDS = 300.0


class PeerSession:
    def __init__(self, session_id: str, peer_id: str, session_key: bytes, role: str):
        self.session_id = session_id
        self.peer_id = peer_id
        self.session_key = session_key
        self.role = role  # "INITIATOR" or "RECEIVER"
        self.created_at = get_utc_timestamp()
        self.is_active = True
        self.messages_count = 0


class SessionManager:
    def __init__(self, identity: IdentityManager):
        self.identity = identity
        self.node_id = identity.node_id

        # session_id -> PeerSession
        self.sessions: Dict[str, PeerSession] = {}
        # peer_id -> active session_id
        self.peer_active_session: Dict[str, str] = {}

        # Replay defense: message_id -> timestamp
        self._seen_messages: Dict[str, float] = {}

        # History log for dashboard/UI
        self.messages_history: List[Dict[str, Any]] = []

    def _check_timestamp(self, ts_str: Optional[str]) -> Tuple[bool, str]:
        if not ts_str:
            return False, "Missing message timestamp"
        try:
            ts = datetime.fromisoformat(ts_str)
            now = datetime.now(timezone.utc)
            skew = abs((now - ts).total_seconds())
            if skew > MAX_MESSAGE_CLOCK_SKEW_SECONDS:
                return False, f"Timestamp out of allowed window ({skew:.1f}s > {MAX_MESSAGE_CLOCK_SKEW_SECONDS}s)"
            return True, "Valid timestamp"
        except Exception as e:
            return False, f"Invalid timestamp format: {e}"

    def get_session(self, session_id: str) -> Optional[PeerSession]:
        return self.sessions.get(session_id)

    def get_peer_session(self, peer_id: str) -> Optional[PeerSession]:
        session_id = self.peer_active_session.get(peer_id)
        if session_id:
            return self.sessions.get(session_id)
        return None

    # =========================================================================
    # Step 3 — Session Key Exchange (§9.2.2 & §9.2.4)
    # =========================================================================
    def create_session_key_exchange(
        self,
        target_peer_id: str,
        target_public_key: Union[rsa.RSAPublicKey, str],
    ) -> dict:
        """
        Step 3: Generate 256-bit AES symmetric key (K_AB), wrap it using target's
        public key via RSA-OAEP, sign the exchange block using own private key,
        and establish local session.
        """
        aes_key = generate_aes_key(32)
        session_id = str(uuid.uuid4())
        ts = get_utc_timestamp()

        # Encrypt session key with peer's RSA Public Key (RSA-OAEP)
        enc_key_bytes = rsa_encrypt_oaep(target_public_key, aes_key)
        encrypted_session_key_b64 = b64_encode(enc_key_bytes)

        # Digital signature over (encrypted_session_key + session_id + timestamp)
        data_to_sign = f"{encrypted_session_key_b64}{session_id}{ts}".encode("utf-8")
        signature_bytes = rsa_sign_pss(self.identity.private_key, data_to_sign)
        signature_b64 = b64_encode(signature_bytes)

        # Store session locally
        session = PeerSession(
            session_id=session_id,
            peer_id=target_peer_id,
            session_key=aes_key,
            role="INITIATOR",
        )
        self.sessions[session_id] = session
        self.peer_active_session[target_peer_id] = session_id

        logger.info("[%s] Generated AES-256 session key for '%s' (session_id: %s)", self.node_id, target_peer_id, session_id)
        return {
            "type": "SESSION_KEY_EXCHANGE",
            "from": self.node_id,
            "to": target_peer_id,
            "encrypted_session_key": encrypted_session_key_b64,
            "session_id": session_id,
            "timestamp": ts,
            "signature": signature_b64,
        }

    def process_session_key_exchange(
        self,
        payload: dict,
        sender_public_key: Union[rsa.RSAPublicKey, str],
    ) -> Tuple[bool, dict, Optional[str]]:
        """
        Step 3 (Receiver side): Verify signature over exchange block,
        decrypt AES session key with own private key (RSA-OAEP),
        and establish active session.
        """
        sender_id = payload.get("from")
        enc_key_b64 = payload.get("encrypted_session_key")
        session_id = payload.get("session_id")
        ts = payload.get("timestamp")
        sig_b64 = payload.get("signature")

        if not sender_id or not enc_key_b64 or not session_id or not sig_b64:
            return False, {
                "status": "ERROR",
                "error_code": "INVALID_PACKET_FORMAT",
                "detail": "Missing fields in SESSION_KEY_EXCHANGE",
            }, "INVALID_PACKET_FORMAT"

        # 1. Clock skew check
        ts_ok, ts_reason = self._check_timestamp(ts)
        if not ts_ok:
            return False, {
                "status": "ERROR",
                "error_code": "REPLAY_ATTACK_DETECTED",
                "detail": ts_reason,
            }, "REPLAY_ATTACK_DETECTED"

        # 2. Verify digital signature using sender's public key
        data_to_verify = f"{enc_key_b64}{session_id}{ts}".encode("utf-8")
        try:
            sig_bytes = b64_decode(sig_b64)
            sig_valid = rsa_verify_pss(sender_public_key, sig_bytes, data_to_verify)
            if not sig_valid:
                logger.warning("[%s] Session key exchange signature verification failed for '%s'", self.node_id, sender_id)
                return False, {
                    "status": "ERROR",
                    "error_code": "SIGNATURE_VERIFICATION_FAILED",
                    "detail": "Digital signature on session key exchange block is invalid",
                }, "SIGNATURE_VERIFICATION_FAILED"
        except Exception as e:
            return False, {
                "status": "ERROR",
                "error_code": "SIGNATURE_VERIFICATION_FAILED",
                "detail": f"Signature verification error: {str(e)}",
            }, "SIGNATURE_VERIFICATION_FAILED"

        # 3. Decrypt session key using own RSA private key
        try:
            enc_key_bytes = b64_decode(enc_key_b64)
            session_key = rsa_decrypt_oaep(self.identity.private_key, enc_key_bytes)
            if len(session_key) != 32:
                return False, {
                    "status": "ERROR",
                    "error_code": "INVALID_KEY_LENGTH",
                    "detail": f"Decrypted key length is {len(session_key)}, expected 32 bytes",
                }, "INVALID_KEY_LENGTH"
        except Exception as e:
            logger.error("[%s] Failed to decrypt session key: %s", self.node_id, e)
            return False, {
                "status": "ERROR",
                "error_code": "DECRYPTION_FAILED",
                "detail": "Failed to decrypt session key with private key",
            }, "DECRYPTION_FAILED"

        # 4. Save session
        session = PeerSession(
            session_id=session_id,
            peer_id=sender_id,
            session_key=session_key,
            role="RECEIVER",
        )
        self.sessions[session_id] = session
        self.peer_active_session[sender_id] = session_id

        logger.info("[%s] Established active session '%s' with peer '%s'", self.node_id, session_id, sender_id)
        return True, {
            "status": "SESSION_ESTABLISHED",
            "session_id": session_id,
            "peer_id": sender_id,
            "timestamp": get_utc_timestamp(),
        }, None

    # =========================================================================
    # Step 4 — Secure Message Encryption & 3-Layer Verification
    # =========================================================================
    def encrypt_message(self, target_peer_id: str, plaintext: str) -> dict:
        """
        Step 4: Encrypt plaintext message with AES-256-GCM, compute SHA-256,
        sign with RSA-PSS private key, and construct SECURE_MESSAGE packet.
        """
        session = self.get_peer_session(target_peer_id)
        if not session or not session.is_active:
            raise RuntimeError(f"No active AES session with peer '{target_peer_id}'. Perform handshake first.")

        message_id = str(uuid.uuid4())
        ts = get_utc_timestamp()
        plaintext_bytes = plaintext.encode("utf-8")

        # 1. Symmetric encryption: AES-256-GCM
        ciphertext, iv, tag = aes_gcm_encrypt(session.session_key, plaintext_bytes)

        # 2. Integrity: SHA-256 of plaintext
        hash_bytes = compute_sha256_bytes(plaintext_bytes)
        hash_b64 = b64_encode(hash_bytes)

        # 3. Non-repudiation: RSA-PSS digital signature over hash
        sig_bytes = rsa_sign_pss(self.identity.private_key, hash_bytes)
        sig_b64 = b64_encode(sig_bytes)

        packet = {
            "type": "SECURE_MESSAGE",
            "from": self.node_id,
            "to": target_peer_id,
            "session_id": session.session_id,
            "payload": {
                "ciphertext": b64_encode(ciphertext),
                "iv": b64_encode(iv),
                "tag": b64_encode(tag),
            },
            "integrity": {
                "hash": hash_b64,
                "signature": sig_b64,
            },
            "timestamp": ts,
            "message_id": message_id,
        }

        # Record in local history
        self.messages_history.append({
            "direction": "OUTBOUND",
            "message_id": message_id,
            "peer_id": target_peer_id,
            "session_id": session.session_id,
            "plaintext": plaintext,
            "timestamp": ts,
            "verification": {
                "layer1_replay": "PASSED",
                "layer2_gcm": "PASSED",
                "layer3_signature": "PASSED",
            },
            "packet": packet,
        })
        session.messages_count += 1

        return packet

    def decrypt_and_verify_message(
        self,
        payload: dict,
        sender_public_key: Union[rsa.RSAPublicKey, str],
    ) -> Tuple[bool, dict, Optional[str]]:
        """
        Step 4 (Receiver side): Execute 3-layer security verification:
        - Layer 1: Anti-replay (message_id and timestamp check)
        - Layer 2: AES-256-GCM authentication tag check (tamper detection)
        - Layer 3: SHA-256 hash & RSA-PSS digital signature verification
        """
        sender_id = payload.get("from")
        session_id = payload.get("session_id")
        message_id = payload.get("message_id")
        ts = payload.get("timestamp")
        payload_data = payload.get("payload") or {}
        integrity = payload.get("integrity") or {}

        # ---------------------------------------------------------------------
        # LAYER 1: Anti-Replay & Freshness Check
        # ---------------------------------------------------------------------
        if not message_id:
            return False, {
                "status": "REPLAY_ATTACK_DETECTED",
                "error_code": "E_REPLAY",
                "detail": "Missing message_id in packet header",
                "layer_failed": 1,
            }, "REPLAY_ATTACK_DETECTED"

        if message_id in self._seen_messages:
            logger.warning("[%s] Replay attack detected: message_id '%s' was already processed", self.node_id, message_id)
            return False, {
                "status": "REPLAY_ATTACK_DETECTED",
                "error_code": "E_REPLAY",
                "detail": f"Replay attack detected: message_id '{message_id}' already seen",
                "layer_failed": 1,
            }, "REPLAY_ATTACK_DETECTED"

        ts_ok, ts_reason = self._check_timestamp(ts)
        if not ts_ok:
            return False, {
                "status": "REPLAY_ATTACK_DETECTED",
                "error_code": "E_TIMESTAMP_EXPIRED",
                "detail": ts_reason,
                "layer_failed": 1,
            }, "REPLAY_ATTACK_DETECTED"

        # ---------------------------------------------------------------------
        # LAYER 2: Symmetric Integrity Check (AES-256-GCM Auth Tag)
        # ---------------------------------------------------------------------
        session = self.get_session(session_id)
        if not session or not session.is_active:
            return False, {
                "status": "SESSION_NOT_FOUND",
                "error_code": "E_SESSION_NOT_FOUND",
                "detail": f"No active session found with id '{session_id}'",
                "layer_failed": 2,
            }, "SESSION_NOT_FOUND"

        try:
            ciphertext = b64_decode(payload_data.get("ciphertext", ""))
            iv = b64_decode(payload_data.get("iv", ""))
            tag = b64_decode(payload_data.get("tag", ""))
            plaintext_bytes = aes_gcm_decrypt(session.session_key, iv, ciphertext, tag)
        except InvalidTag:
            logger.warning("[%s] AES-GCM Auth tag mismatch! Ciphertext was tampered in transit", self.node_id)
            return False, {
                "status": "INTEGRITY_CHECK_FAILED",
                "error_code": "E_TAG_MISMATCH",
                "detail": "GCM auth tag mismatch — ciphertext was modified in transit (Tamper Attack)",
                "layer_failed": 2,
            }, "INTEGRITY_CHECK_FAILED"
        except Exception as e:
            logger.warning("[%s] Decryption error: %s", self.node_id, e)
            return False, {
                "status": "INTEGRITY_CHECK_FAILED",
                "error_code": "E_DECRYPT_ERROR",
                "detail": f"Decryption error: {str(e)}",
                "layer_failed": 2,
            }, "INTEGRITY_CHECK_FAILED"

        # ---------------------------------------------------------------------
        # LAYER 3: Origin Authenticity & Non-repudiation (RSA-PSS Signature)
        # ---------------------------------------------------------------------
        computed_hash_bytes = compute_sha256_bytes(plaintext_bytes)
        computed_hash_b64 = b64_encode(computed_hash_bytes)
        received_hash_b64 = integrity.get("hash")

        if computed_hash_b64 != received_hash_b64:
            logger.warning("[%s] SHA-256 hash mismatch between plaintext and packet integrity header", self.node_id)
            return False, {
                "status": "SIGNATURE_VERIFICATION_FAILED",
                "error_code": "E_HASH_MISMATCH",
                "detail": "SHA-256 hash mismatch with integrity header",
                "layer_failed": 3,
            }, "SIGNATURE_VERIFICATION_FAILED"

        try:
            sig_bytes = b64_decode(integrity.get("signature", ""))
            sig_ok = rsa_verify_pss(sender_public_key, sig_bytes, computed_hash_bytes)
            if not sig_ok:
                logger.warning("[%s] RSA-PSS signature invalid for sender '%s'", self.node_id, sender_id)
                return False, {
                    "status": "SIGNATURE_VERIFICATION_FAILED",
                    "error_code": "E_SIG_INVALID",
                    "detail": "RSA-PSS digital signature mismatch — sender cannot be authenticated",
                    "layer_failed": 3,
                }, "SIGNATURE_VERIFICATION_FAILED"
        except Exception as e:
            return False, {
                "status": "SIGNATURE_VERIFICATION_FAILED",
                "error_code": "E_SIG_INVALID",
                "detail": f"Signature verification exception: {str(e)}",
                "layer_failed": 3,
            }, "SIGNATURE_VERIFICATION_FAILED"

        # ---------------------------------------------------------------------
        # All 3 Layers Passed
        # ---------------------------------------------------------------------
        self._seen_messages[message_id] = time.time()
        plaintext = plaintext_bytes.decode("utf-8")
        session.messages_count += 1

        res = {
            "status": "MESSAGE_RECEIVED",
            "message_id": message_id,
            "from": sender_id,
            "session_id": session_id,
            "decrypted_plaintext": plaintext,
            "verification": {
                "layer1_replay": "PASSED",
                "layer2_gcm": "PASSED",
                "layer3_signature": "PASSED",
            },
            "timestamp": ts,
        }

        self.messages_history.append({
            "direction": "INBOUND",
            "message_id": message_id,
            "peer_id": sender_id,
            "session_id": session_id,
            "plaintext": plaintext,
            "timestamp": ts,
            "verification": res["verification"],
            "packet": payload,
        })

        logger.info("[%s] Secure message '%s' successfully decrypted and verified 3/3 layers", self.node_id, message_id)
        return True, res, None

    # =========================================================================
    # Step 4b — Secure File Transfer
    # =========================================================================
    def encrypt_file(
        self,
        target_peer_id: str,
        filename: str,
        file_bytes: bytes,
        mime_type: str = "application/octet-stream",
    ) -> dict:
        """
        Encrypt file bytes using AES-256-GCM, calculate SHA-256 and RSA-PSS signature.
        """
        session = self.get_peer_session(target_peer_id)
        if not session or not session.is_active:
            raise RuntimeError(f"No active AES session with peer '{target_peer_id}'.")

        message_id = str(uuid.uuid4())
        ts = get_utc_timestamp()

        ciphertext, iv, tag = aes_gcm_encrypt(session.session_key, file_bytes)
        hash_bytes = compute_sha256_bytes(file_bytes)
        hash_b64 = b64_encode(hash_bytes)
        sig_bytes = rsa_sign_pss(self.identity.private_key, hash_bytes)

        return {
            "type": "SECURE_FILE",
            "from": self.node_id,
            "to": target_peer_id,
            "session_id": session.session_id,
            "file_meta": {
                "filename": filename,
                "size_bytes": len(file_bytes),
                "mime_type": mime_type,
            },
            "payload": {
                "ciphertext_b64": b64_encode(ciphertext),
                "iv": b64_encode(iv),
                "tag": b64_encode(tag),
            },
            "integrity": {
                "hash": hash_b64,
                "signature": b64_encode(sig_bytes),
            },
            "timestamp": ts,
            "message_id": message_id,
        }

    def decrypt_and_verify_file(
        self,
        payload: dict,
        sender_public_key: Union[rsa.RSAPublicKey, str],
        save_dir: Path,
    ) -> Tuple[bool, dict, Optional[str]]:
        """
        Decrypt and verify file through 3-layer security, and save to save_dir.
        """
        sender_id = payload.get("from")
        session_id = payload.get("session_id")
        message_id = payload.get("message_id")
        file_meta = payload.get("file_meta") or {}
        filename = file_meta.get("filename", "received_file")
        payload_data = payload.get("payload") or {}
        integrity = payload.get("integrity") or {}

        # Layer 1: Replay check
        if not message_id or message_id in self._seen_messages:
            return False, {
                "status": "REPLAY_ATTACK_DETECTED",
                "error_code": "E_REPLAY",
                "detail": f"Replay detected: file message_id '{message_id}' already seen",
                "layer_failed": 1,
            }, "REPLAY_ATTACK_DETECTED"

        # Layer 2: GCM Tag check
        session = self.get_session(session_id)
        if not session or not session.is_active:
            return False, {
                "status": "SESSION_NOT_FOUND",
                "error_code": "E_SESSION_NOT_FOUND",
                "detail": "Active session not found",
                "layer_failed": 2,
            }, "SESSION_NOT_FOUND"

        try:
            ciphertext = b64_decode(payload_data.get("ciphertext_b64", ""))
            iv = b64_decode(payload_data.get("iv", ""))
            tag = b64_decode(payload_data.get("tag", ""))
            file_bytes = aes_gcm_decrypt(session.session_key, iv, ciphertext, tag)
        except InvalidTag:
            return False, {
                "status": "INTEGRITY_CHECK_FAILED",
                "error_code": "E_TAG_MISMATCH",
                "detail": "GCM auth tag mismatch: file content was tampered",
                "layer_failed": 2,
            }, "INTEGRITY_CHECK_FAILED"

        # Layer 3: SHA-256 and RSA signature
        computed_hash = compute_sha256_bytes(file_bytes)
        if b64_encode(computed_hash) != integrity.get("hash"):
            return False, {
                "status": "SIGNATURE_VERIFICATION_FAILED",
                "error_code": "E_HASH_MISMATCH",
                "detail": "File SHA-256 hash mismatch",
                "layer_failed": 3,
            }, "SIGNATURE_VERIFICATION_FAILED"

        sig_bytes = b64_decode(integrity.get("signature", ""))
        if not rsa_verify_pss(sender_public_key, sig_bytes, computed_hash):
            return False, {
                "status": "SIGNATURE_VERIFICATION_FAILED",
                "error_code": "E_SIG_INVALID",
                "detail": "File signature invalid",
                "layer_failed": 3,
            }, "SIGNATURE_VERIFICATION_FAILED"

        # Save file
        save_dir = Path(save_dir)
        save_dir.mkdir(parents=True, exist_ok=True)
        out_path = save_dir / filename
        out_path.write_bytes(file_bytes)

        self._seen_messages[message_id] = time.time()
        return True, {
            "status": "FILE_RECEIVED",
            "message_id": message_id,
            "filename": filename,
            "size_bytes": len(file_bytes),
            "save_path": str(out_path),
            "verification": {
                "layer1_replay": "PASSED",
                "layer2_gcm": "PASSED",
                "layer3_signature": "PASSED",
            },
        }, None

