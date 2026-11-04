"""
Packet Interceptor & Transparent Relay for MITM Proxy (§9.1.1).
Listens for HTTP packets with X-Target-URL header, extracts metadata,
and manages Passthrough vs Hold (Intercept) forwarding modes.
"""
import asyncio
import json
import logging
from typing import Optional, Dict, Any, Tuple, List, Callable, Awaitable
import httpx

from shared.crypto_utils import get_utc_timestamp
from mitm_proxy.core.packet_store import PacketStore, PacketRecord

logger = logging.getLogger("mitm_proxy.interceptor")


def normalize_target_url(url: str) -> str:
    """Normalize docker container hostnames from node_x to peer_x if necessary."""
    for n in ("node_a", "node_b", "node_c"):
        if f"://{n}:" in url:
            url = url.replace(f"://{n}:", f"://peer_{n[-1]}:")
    return url


class Interceptor:
    def __init__(
        self,
        packet_store: PacketStore,
        broadcast_func: Optional[Callable[[Dict[str, Any]], Awaitable[None]]] = None,
        default_mode: str = "passthrough",
        hold_timeout: float = 60.0,
        http_client: Optional[httpx.AsyncClient] = None,
    ):
        self.packet_store = packet_store
        self.broadcast_func = broadcast_func
        self.mode = default_mode.lower()
        self.hold_timeout = hold_timeout
        self._custom_client = http_client
        self._internal_client: Optional[httpx.AsyncClient] = None
        # packet_id -> asyncio.Future
        self._held_futures: Dict[str, asyncio.Future] = {}

    async def _get_client(self) -> httpx.AsyncClient:
        if self._custom_client is not None:
            return self._custom_client
        if self._internal_client is None or self._internal_client.is_closed:
            self._internal_client = httpx.AsyncClient(timeout=15.0)
        return self._internal_client

    async def aclose(self) -> None:
        """Close internal HTTP client resources."""
        if self._internal_client and not self._internal_client.is_closed:
            await self._internal_client.aclose()
            self._internal_client = None

    def set_mode(self, mode: str) -> str:
        """Switch between 'passthrough' and 'hold' (or 'intercept') mode."""
        clean_mode = mode.lower().strip()
        if clean_mode not in ("passthrough", "hold", "intercept"):
            raise ValueError(f"Invalid proxy mode '{mode}'. Choose 'passthrough' or 'hold'.")
        # Normalize 'intercept' to 'hold'
        if clean_mode == "intercept":
            clean_mode = "hold"
        self.mode = clean_mode
        logger.info("Proxy interceptor mode changed to: %s", self.mode)
        return self.mode

    def is_held(self, packet_id: str) -> bool:
        """Check if a packet is currently held waiting for release or attack."""
        return packet_id in self._held_futures and not self._held_futures[packet_id].done()

    def get_held_packet_ids(self) -> List[str]:
        """Return list of packet IDs currently in HELD state."""
        return [pid for pid, fut in self._held_futures.items() if not fut.done()]

    def held_count(self) -> int:
        """Return number of currently held packets."""
        return len(self.get_held_packet_ids())

    async def _broadcast_event(self, event_data: dict) -> None:
        """Send event notification to WebSocket broadcast handler if configured."""
        if self.broadcast_func:
            try:
                await self.broadcast_func(event_data)
            except Exception as e:
                logger.warning("Failed to broadcast WebSocket event: %s", e)

    def _extract_packet_metadata(self, target_url: str, json_data: dict) -> Tuple[str, str, str]:
        """
        Extract packet_type, direction, and timestamp from payload or destination URL.
        """
        # 1. Packet type
        packet_type = json_data.get("type")
        if not packet_type:
            # Deduce from target URL path
            url_lower = target_url.lower()
            if "/handshake/init" in url_lower:
                packet_type = "HANDSHAKE_INIT"
            elif "/handshake/respond" in url_lower:
                packet_type = "HANDSHAKE_RESPOND"
            elif "/handshake/confirm" in url_lower:
                packet_type = "HANDSHAKE_CONFIRM"
            elif "/session/key" in url_lower:
                packet_type = "SESSION_KEY_EXCHANGE"
            elif "/message" in url_lower:
                packet_type = "SECURE_MESSAGE"
            elif "/file" in url_lower:
                packet_type = "SECURE_FILE"
            else:
                packet_type = "UNKNOWN"

        # 2. Direction
        sender = json_data.get("from")
        target = json_data.get("to")
        if sender and target:
            direction = f"{sender} → {target}"
        elif sender:
            direction = f"{sender} → ?"
        else:
            direction = "unknown"

        # 3. Timestamp
        timestamp = json_data.get("timestamp") or get_utc_timestamp()

        return packet_type, direction, timestamp

    async def handle_forward(
        self,
        target_url: str,
        body_bytes: bytes,
        headers: Dict[str, str],
    ) -> Tuple[int, Any, Dict[str, str]]:
        """
        Main relay handler called by POST /forward.
        Intercepts the packet, stores it, broadcasts events,
        and either forwards immediately (passthrough) or holds for operator decision.
        """
        target_url = normalize_target_url(target_url)
        # Parse JSON body
        try:
            json_data = json.loads(body_bytes.decode("utf-8"))
        except Exception:
            json_data = {"raw_content": body_bytes.decode("utf-8", errors="replace")}

        packet_type, direction, timestamp = self._extract_packet_metadata(target_url, json_data)
        packet_id = self.packet_store.next_id()

        # Sanitize headers for forwarding
        forward_headers = {
            k: v for k, v in headers.items()
            if k.lower() not in ("host", "content-length", "x-target-url")
        }
        if "content-type" not in [k.lower() for k in forward_headers]:
            forward_headers["Content-Type"] = "application/json"

        # =====================================================================
        # 1. PASSTHROUGH MODE: Inspect, Store, and Forward Immediately
        # =====================================================================
        if self.mode == "passthrough":
            record = PacketRecord(
                packet_id=packet_id,
                timestamp=timestamp,
                direction=direction,
                packet_type=packet_type,
                target_url=target_url,
                raw_json=json_data,
                raw_headers=forward_headers,
                status="FORWARDED",
            )
            self.packet_store.add_packet(record)

            # Broadcast interception
            await self._broadcast_event({
                "event": "PACKET_INTERCEPTED",
                "packet_id": packet_id,
                "direction": direction,
                "packet_type": packet_type,
                "target_url": target_url,
                "raw_json": json_data,
                "intercepted_at": timestamp,
                "status": "FORWARDED",
            })

            # Actually forward to target peer
            client = await self._get_client()
            try:
                res = await client.post(target_url, json=json_data, headers=forward_headers)
                try:
                    res_body = res.json()
                except Exception:
                    res_body = {"text": res.text}

                record.receiver_response = res_body
                record.forwarded_at = get_utc_timestamp()
                return res.status_code, res_body, dict(res.headers)

            except Exception as e:
                logger.error("Failed to forward packet to %s: %s", target_url, e)
                error_body = {"status": "ERROR", "error_code": "E_DESTINATION_UNREACHABLE", "detail": str(e)}
                record.receiver_response = error_body
                return 502, error_body, {}

        # =====================================================================
        # 2. HOLD MODE: Intercept, Buffer, and Await Attack/Release Command
        # =====================================================================
        record = PacketRecord(
            packet_id=packet_id,
            timestamp=timestamp,
            direction=direction,
            packet_type=packet_type,
            target_url=target_url,
            raw_json=json_data,
            raw_headers=forward_headers,
            status="HELD",
        )
        self.packet_store.add_packet(record)

        # Broadcast packet held event
        await self._broadcast_event({
            "event": "PACKET_INTERCEPTED",
            "packet_id": packet_id,
            "direction": direction,
            "packet_type": packet_type,
            "target_url": target_url,
            "raw_json": json_data,
            "intercepted_at": timestamp,
            "status": "HELD",
        })

        # Create future for asynchronous resolution
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        self._held_futures[packet_id] = future

        logger.info("Packet %s (%s, %s) is HELD. Waiting for release or attack...", packet_id, packet_type, direction)

        try:
            decision = await asyncio.wait_for(future, timeout=self.hold_timeout)
        except asyncio.TimeoutError:
            self._held_futures.pop(packet_id, None)
            record.status = "TIMEOUT"
            logger.warning("Held packet %s timed out waiting for operator decision", packet_id)
            return (
                504,
                {
                    "status": "ERROR",
                    "error_code": "E_HELD_TIMEOUT",
                    "detail": f"Held packet '{packet_id}' timed out after {self.hold_timeout}s waiting for action",
                },
                {},
            )
        finally:
            self._held_futures.pop(packet_id, None)

        action = decision.get("action", "RELEASE")

        # Case A: Attack engine already performed the forward directly
        if action == "RESOLVED":
            status_code = decision.get("status_code", 200)
            res_body = decision.get("response_body", {})
            return status_code, res_body, decision.get("headers", {})

        # Case B: Released with payload (original or modified)
        payload_to_send = decision.get("payload", json_data)
        client = await self._get_client()
        try:
            res = await client.post(target_url, json=payload_to_send, headers=forward_headers)
            try:
                res_body = res.json()
            except Exception:
                res_body = {"text": res.text}

            record.status = decision.get("final_status", "FORWARDED")
            record.receiver_response = res_body
            record.forwarded_at = get_utc_timestamp()
            return res.status_code, res_body, dict(res.headers)

        except Exception as e:
            logger.error("Failed to forward released packet %s: %s", packet_id, e)
            error_body = {"status": "ERROR", "error_code": "E_DESTINATION_UNREACHABLE", "detail": str(e)}
            record.receiver_response = error_body
            return 502, error_body, {}

    def release_held_packet(
        self,
        packet_id: Optional[str] = None,
        payload_override: Optional[dict] = None,
        final_status: str = "FORWARDED",
    ) -> Tuple[bool, str, Optional[PacketRecord]]:
        """
        Release a currently held packet, unblocking its /forward HTTP request.
        If packet_id is None, releases the most recently held packet.
        """
        if packet_id is None:
            latest = self.packet_store.get_latest_held_packet()
            if not latest:
                return False, "No packet is currently held", None
            packet_id = latest.packet_id

        future = self._held_futures.get(packet_id)
        if not future or future.done():
            return False, f"Packet '{packet_id}' is not in active HELD state", None

        pkt = self.packet_store.get_packet(packet_id)
        payload = payload_override if payload_override is not None else (pkt.raw_json if pkt else {})

        decision = {
            "action": "RELEASE",
            "payload": payload,
            "final_status": final_status,
        }
        future.set_result(decision)
        logger.info("Released held packet %s (final_status=%s)", packet_id, final_status)
        return True, f"Released packet {packet_id}", pkt

    def resolve_held_packet(
        self,
        packet_id: str,
        status_code: int,
        response_body: Any,
        headers: Optional[Dict[str, str]] = None,
    ) -> bool:
        """
        Directly resolve a held packet when the attack engine has already forwarded it.
        """
        future = self._held_futures.get(packet_id)
        if not future or future.done():
            return False

        future.set_result({
            "action": "RESOLVED",
            "status_code": status_code,
            "response_body": response_body,
            "headers": headers or {},
        })
        return True

