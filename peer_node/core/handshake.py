"""
Mutual Authentication Handshake Protocol for Peer Nodes.
Implements 3-step Challenge-Response protocol using X.509 certificates and nonces (§9.3.2).
Includes replay attack defense and clock skew validation.
"""
import logging
import time
from datetime import datetime, timezone
from typing import Dict, Optional, Tuple, Any

from cryptography.hazmat.primitives.asymmetric import rsa

from peer_node.core.identity import IdentityManager
from shared.crypto_utils import (
    generate_nonce_b64,
    b64_encode,
    b64_decode,
    rsa_encrypt_oaep,
    rsa_decrypt_oaep,
    pem_to_cert,
    get_utc_timestamp,
)

logger = logging.getLogger("peer_node.handshake")

NONCE_EXPIRY_SECONDS = 300.0  # 5 minutes replay cache window
MAX_CLOCK_SKEW_SECONDS = 300.0


class HandshakeState:
    def __init__(self, target_peer_id: str, role: str):
        self.target_peer_id = target_peer_id
        self.role = role  # "INITIATOR" or "RESPONDER"
        self.status = "PENDING"  # PENDING, RESPONDED, AUTHENTICATED, FAILED
        self.nonce_sent: Optional[str] = None
        self.nonce_received: Optional[str] = None
        self.peer_cert_pem: Optional[str] = None
        self.peer_public_key: Optional[rsa.RSAPublicKey] = None
        self.error: Optional[str] = None
        self.created_at = time.time()
        self.authenticated_at: Optional[str] = None


class HandshakeManager:
    def __init__(self, identity: IdentityManager):
        self.identity = identity
        self.node_id = identity.node_id

        # peer_id -> HandshakeState
        self.handshakes: Dict[str, HandshakeState] = {}
        # peer_id -> dict with verified info
        self.authenticated_peers: Dict[str, Dict[str, Any]] = {}

        # Replay prevention cache: nonce_str -> timestamp
        self._used_nonces: Dict[str, float] = {}

    def _clean_expired_nonces(self) -> None:
        """Evict nonces older than NONCE_EXPIRY_SECONDS."""
        now = time.time()
        expired = [n for n, ts in self._used_nonces.items() if now - ts > NONCE_EXPIRY_SECONDS]
        for n in expired:
            del self._used_nonces[n]

    def _check_timestamp(self, ts_str: Optional[str]) -> Tuple[bool, str]:
        """Validate ISO timestamp against current UTC clock."""
        if not ts_str:
            return False, "Missing timestamp"
        try:
            ts = datetime.fromisoformat(ts_str)
            now = datetime.now(timezone.utc)
            skew = abs((now - ts).total_seconds())
            if skew > MAX_CLOCK_SKEW_SECONDS:
                return False, f"Timestamp out of allowed clock skew ({skew:.1f}s > {MAX_CLOCK_SKEW_SECONDS}s)"
            return True, "Valid timestamp"
        except Exception as e:
            return False, f"Invalid timestamp format: {e}"

    def is_peer_authenticated(self, peer_id: str) -> bool:
        """Check if peer has completed mutual authentication."""
        return peer_id in self.authenticated_peers

    def get_peer_public_key(self, peer_id: str) -> Optional[rsa.RSAPublicKey]:
        """Get verified public key of an authenticated peer."""
        entry = self.authenticated_peers.get(peer_id)
        if entry:
            return entry.get("public_key")
        return None

    def get_peer_cert_pem(self, peer_id: str) -> Optional[str]:
        """Get verified certificate PEM of an authenticated peer."""
        entry = self.authenticated_peers.get(peer_id)
        if entry:
            return entry.get("certificate_pem")
        return None

    # =========================================================================
    # Step 2a — Initiator creates HANDSHAKE_INIT (Node A -> Node B)
    # =========================================================================
    def create_handshake_init(self, target_peer_id: str) -> dict:
        """
        Step 2a: Generate nonce_A, package own certificate, and prepare HANDSHAKE_INIT.
        """
        self._clean_expired_nonces()

        if not self.identity.certificate_pem:
            raise RuntimeError(f"Cannot initiate handshake: {self.node_id} has no certificate")

        nonce_A = generate_nonce_b64(32)
        self._used_nonces[nonce_A] = time.time()

        state = HandshakeState(target_peer_id=target_peer_id, role="INITIATOR")
        state.nonce_sent = nonce_A
        state.status = "INITIATED"
        self.handshakes[target_peer_id] = state

        logger.info("[%s] Initiating mutual authentication handshake with '%s'", self.node_id, target_peer_id)
        return {
            "type": "HANDSHAKE_INIT",
            "from": self.node_id,
            "to": target_peer_id,
            "certificate_pem": self.identity.certificate_pem,
            "nonce_A": nonce_A,
            "timestamp": get_utc_timestamp(),
        }

    # =========================================================================
    # Step 2b — Responder processes HANDSHAKE_INIT and produces HANDSHAKE_RESPOND
    # =========================================================================
    def process_handshake_init(self, payload: dict) -> Tuple[bool, dict, Optional[str]]:
        """
        Step 2b: Responder verifies initiator's cert & nonce, generates nonce_B,
        encrypts nonce_A with initiator's public key, and returns HANDSHAKE_RESPOND.
        """
        self._clean_expired_nonces()

        sender_id = payload.get("from")
        target_id = payload.get("to")
        cert_pem = payload.get("certificate_pem")
        nonce_A = payload.get("nonce_A")
        ts = payload.get("timestamp")

        # 1. Basic validation
        if not sender_id or not cert_pem or not nonce_A:
            return False, {
                "status": "ERROR",
                "error_code": "INVALID_PACKET_FORMAT",
                "detail": "Missing required handshake fields (from, certificate_pem, nonce_A)",
            }, "INVALID_PACKET_FORMAT"

        # 2. Clock skew check
        ts_ok, ts_reason = self._check_timestamp(ts)
        if not ts_ok:
            return False, {
                "status": "ERROR",
                "error_code": "REPLAY_ATTACK_DETECTED",
                "detail": ts_reason,
            }, "REPLAY_ATTACK_DETECTED"

        # 3. Replay attack check on nonce_A
        if nonce_A in self._used_nonces:
            logger.warning("[%s] Replay attack detected: nonce_A '%s' was already used", self.node_id, nonce_A[:8])
            return False, {
                "status": "ERROR",
                "error_code": "REPLAY_ATTACK_DETECTED",
                "detail": f"Replay detected: nonce_A has already been processed",
            }, "REPLAY_ATTACK_DETECTED"
        self._used_nonces[nonce_A] = time.time()

        # 4. Verify certificate chain with CA public key
        is_valid, reason = self.identity.verify_peer_certificate(cert_pem)
        if not is_valid:
            logger.warning("[%s] Peer '%s' certificate verification failed: %s", self.node_id, sender_id, reason)
            return False, {
                "status": "ERROR",
                "error_code": "CERTIFICATE_VERIFICATION_FAILED",
                "detail": reason,
            }, "CERTIFICATE_VERIFICATION_FAILED"

        # 5. Extract initiator's Public Key from verified certificate
        try:
            peer_cert_obj = pem_to_cert(cert_pem)
            pk_A = peer_cert_obj.public_key()
        except Exception as e:
            return False, {
                "status": "ERROR",
                "error_code": "CERTIFICATE_PARSING_FAILED",
                "detail": str(e),
            }, "CERTIFICATE_PARSING_FAILED"

        # 6. Generate nonce_B and protect against replay
        nonce_B = generate_nonce_b64(32)
        self._used_nonces[nonce_B] = time.time()

        # 7. Encrypt nonce_A using PK_A with RSA-OAEP
        try:
            enc_nonce_A_bytes = rsa_encrypt_oaep(pk_A, nonce_A.encode("utf-8"))
            encrypted_nonce_A = b64_encode(enc_nonce_A_bytes)
        except Exception as e:
            logger.error("[%s] Failed to encrypt challenge nonce_A: %s", self.node_id, e)
            return False, {
                "status": "ERROR",
                "error_code": "ENCRYPTION_FAILED",
                "detail": f"Failed encrypting nonce: {str(e)}",
            }, "ENCRYPTION_FAILED"

        # 8. Record handshake responder state
        state = HandshakeState(target_peer_id=sender_id, role="RESPONDER")
        state.nonce_sent = nonce_B
        state.nonce_received = nonce_A
        state.peer_cert_pem = cert_pem
        state.peer_public_key = pk_A
        state.status = "RESPONDED"
        self.handshakes[sender_id] = state

        logger.info("[%s] Responding to handshake init from '%s'", self.node_id, sender_id)
        response_payload = {
            "type": "HANDSHAKE_RESPOND",
            "from": self.node_id,
            "to": sender_id,
            "certificate_pem": self.identity.certificate_pem,
            "nonce_B": nonce_B,
            "encrypted_nonce_A": encrypted_nonce_A,
            "timestamp": get_utc_timestamp(),
        }
        return True, response_payload, None

    # =========================================================================
    # Step 2b (Client side) & Step 2c (Confirm)
    # =========================================================================
    def process_handshake_respond(self, payload: dict) -> Tuple[bool, dict, Optional[str]]:
        """
        Step 2b (Initiator side): Decrypt encrypted_nonce_A, verify it equals nonce_A,
        verify responder's certificate, encrypt nonce_B with PK_B, and produce HANDSHAKE_CONFIRM.
        """
        self._clean_expired_nonces()

        sender_id = payload.get("from")
        cert_pem = payload.get("certificate_pem")
        nonce_B = payload.get("nonce_B")
        encrypted_nonce_A = payload.get("encrypted_nonce_A")
        ts = payload.get("timestamp")

        state = self.handshakes.get(sender_id)
        if not state or state.role != "INITIATOR" or not state.nonce_sent:
            return False, {
                "status": "ERROR",
                "error_code": "INVALID_HANDSHAKE_STATE",
                "detail": f"No pending initiation for peer '{sender_id}'",
            }, "INVALID_HANDSHAKE_STATE"

        # 1. Clock skew check
        ts_ok, ts_reason = self._check_timestamp(ts)
        if not ts_ok:
            return False, {
                "status": "ERROR",
                "error_code": "REPLAY_ATTACK_DETECTED",
                "detail": ts_reason,
            }, "REPLAY_ATTACK_DETECTED"

        # 2. Replay check on nonce_B
        if not nonce_B or nonce_B in self._used_nonces:
            return False, {
                "status": "ERROR",
                "error_code": "REPLAY_ATTACK_DETECTED",
                "detail": "Replay detected: nonce_B has already been used",
            }, "REPLAY_ATTACK_DETECTED"
        self._used_nonces[nonce_B] = time.time()

        # 3. Verify responder's certificate
        is_valid, reason = self.identity.verify_peer_certificate(cert_pem)
        if not is_valid:
            logger.warning("[%s] Responder '%s' certificate failed verification: %s", self.node_id, sender_id, reason)
            return False, {
                "status": "ERROR",
                "error_code": "CERTIFICATE_VERIFICATION_FAILED",
                "detail": reason,
            }, "CERTIFICATE_VERIFICATION_FAILED"

        try:
            peer_cert_obj = pem_to_cert(cert_pem)
            pk_B = peer_cert_obj.public_key()
        except Exception as e:
            return False, {
                "status": "ERROR",
                "error_code": "CERTIFICATE_PARSING_FAILED",
                "detail": str(e),
            }, "CERTIFICATE_PARSING_FAILED"

        # 4. Decrypt encrypted_nonce_A with SK_A
        try:
            enc_bytes = b64_decode(encrypted_nonce_A)
            dec_bytes = rsa_decrypt_oaep(self.identity.private_key, enc_bytes)
            decrypted_nonce_A = dec_bytes.decode("utf-8")
        except Exception as e:
            logger.warning("[%s] Failed decrypting challenge nonce_A: %s", self.node_id, e)
            return False, {
                "status": "ERROR",
                "error_code": "CHALLENGE_VERIFICATION_FAILED",
                "detail": "Failed to decrypt challenge nonce_A with private key",
            }, "CHALLENGE_VERIFICATION_FAILED"

        # 5. Challenge match check
        if decrypted_nonce_A != state.nonce_sent:
            logger.warning("[%s] Challenge verification failed: decrypted nonce_A does not match original", self.node_id)
            return False, {
                "status": "ERROR",
                "error_code": "CHALLENGE_VERIFICATION_FAILED",
                "detail": "Decrypted nonce_A does not match original challenge",
            }, "CHALLENGE_VERIFICATION_FAILED"

        # 6. Encrypt nonce_B using PK_B with RSA-OAEP
        try:
            enc_nonce_B_bytes = rsa_encrypt_oaep(pk_B, nonce_B.encode("utf-8"))
            encrypted_nonce_B = b64_encode(enc_nonce_B_bytes)
        except Exception as e:
            return False, {
                "status": "ERROR",
                "error_code": "ENCRYPTION_FAILED",
                "detail": f"Failed encrypting nonce_B: {e}",
            }, "ENCRYPTION_FAILED"

        # 7. Mark authenticated on initiator side
        state.nonce_received = nonce_B
        state.peer_cert_pem = cert_pem
        state.peer_public_key = pk_B
        state.status = "AUTHENTICATED"
        state.authenticated_at = get_utc_timestamp()

        self.authenticated_peers[sender_id] = {
            "peer_id": sender_id,
            "public_key": pk_B,
            "certificate_pem": cert_pem,
            "authenticated_at": state.authenticated_at,
        }

        logger.info("[%s] Handshake challenge verified for '%s'. Mutual authentication successful!", self.node_id, sender_id)
        confirm_payload = {
            "type": "HANDSHAKE_CONFIRM",
            "from": self.node_id,
            "to": sender_id,
            "encrypted_nonce_B": encrypted_nonce_B,
            "status": "AUTH_SUCCESS",
            "timestamp": get_utc_timestamp(),
        }
        return True, confirm_payload, None

    # =========================================================================
    # Step 2c (Responder side) — Verify HANDSHAKE_CONFIRM
    # =========================================================================
    def process_handshake_confirm(self, payload: dict) -> Tuple[bool, dict, Optional[str]]:
        """
        Step 2c (Responder side): Decrypt encrypted_nonce_B, verify it equals nonce_B,
        mark mutual authentication as complete.
        """
        sender_id = payload.get("from")
        encrypted_nonce_B = payload.get("encrypted_nonce_B")
        ts = payload.get("timestamp")

        state = self.handshakes.get(sender_id)
        if not state or state.role != "RESPONDER" or not state.nonce_sent:
            return False, {
                "status": "ERROR",
                "error_code": "INVALID_HANDSHAKE_STATE",
                "detail": f"No pending response for peer '{sender_id}'",
            }, "INVALID_HANDSHAKE_STATE"

        # 1. Clock skew check
        ts_ok, ts_reason = self._check_timestamp(ts)
        if not ts_ok:
            return False, {
                "status": "ERROR",
                "error_code": "REPLAY_ATTACK_DETECTED",
                "detail": ts_reason,
            }, "REPLAY_ATTACK_DETECTED"

        # 2. Decrypt encrypted_nonce_B with SK_B
        try:
            enc_bytes = b64_decode(encrypted_nonce_B)
            dec_bytes = rsa_decrypt_oaep(self.identity.private_key, enc_bytes)
            decrypted_nonce_B = dec_bytes.decode("utf-8")
        except Exception as e:
            logger.warning("[%s] Failed decrypting challenge nonce_B: %s", self.node_id, e)
            return False, {
                "status": "ERROR",
                "error_code": "CHALLENGE_VERIFICATION_FAILED",
                "detail": "Failed to decrypt challenge nonce_B with private key",
            }, "CHALLENGE_VERIFICATION_FAILED"

        # 3. Verify challenge match
        if decrypted_nonce_B != state.nonce_sent:
            logger.warning("[%s] Challenge verification failed: decrypted nonce_B does not match original", self.node_id)
            return False, {
                "status": "ERROR",
                "error_code": "CHALLENGE_VERIFICATION_FAILED",
                "detail": "Decrypted nonce_B does not match original challenge",
            }, "CHALLENGE_VERIFICATION_FAILED"

        # 4. Mark authenticated on responder side
        state.status = "AUTHENTICATED"
        state.authenticated_at = get_utc_timestamp()

        self.authenticated_peers[sender_id] = {
            "peer_id": sender_id,
            "public_key": state.peer_public_key,
            "certificate_pem": state.peer_cert_pem,
            "authenticated_at": state.authenticated_at,
        }

        logger.info("[%s] Confirmed mutual authentication with '%s'. AUTH_SUCCESS!", self.node_id, sender_id)
        return True, {
            "type": "HANDSHAKE_RESULT",
            "from": self.node_id,
            "peer_id": sender_id,
            "status": "AUTH_SUCCESS",
            "detail": "Mutual authentication completed successfully",
            "timestamp": state.authenticated_at,
        }, None

