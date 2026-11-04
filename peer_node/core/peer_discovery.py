"""
Peer Discovery & Directory Service for Peer Node.
Periodically queries CA server (/peers) to maintain local directory of active peers,
endpoints, and certificates (§9.2.4).
"""
import logging
from typing import Dict, List, Optional, Any

import httpx

logger = logging.getLogger("peer_node.discovery")

# Standard Docker/Local fallback mapping
DEFAULT_PORT_MAPPING = {
    "node_a": 8001,
    "node_b": 8002,
    "node_c": 8003,
}


class PeerDiscovery:
    def __init__(self, node_id: str, ca_url: str):
        self.node_id = node_id
        self.ca_url = ca_url.rstrip("/")
        # peer_id -> dict
        self.peers: Dict[str, dict] = {}
        # peer_id -> cert_pem
        self.peer_certs: Dict[str, str] = {}

    def resolve_endpoint(self, peer_id: str, registered_endpoint: Optional[str] = None) -> str:
        """
        Resolve the reachable HTTP URL for a given peer_id.
        Priority:
        1. Registered endpoint from CA (if provided).
        2. Container hostname in docker network: http://peer_<id_suffix>:<port> or http://<peer_id>:<port>.
        """
        if registered_endpoint and registered_endpoint.strip():
            return registered_endpoint.strip().rstrip("/")

        # Auto-fallback based on node_id naming convention
        port = DEFAULT_PORT_MAPPING.get(peer_id)
        if port:
            # Inside docker network service names are peer_a, peer_b, peer_c
            # If peer_id is "node_a" -> host is "peer_a"
            host = peer_id.replace("node_", "peer_")
            return f"http://{host}:{port}"

        # Default fallback
        return f"http://{peer_id}:8000"

    async def fetch_peers(self, client: Optional[httpx.AsyncClient] = None) -> List[dict]:
        """
        Query CA Server GET /peers to discover all registered nodes.
        """
        url = f"{self.ca_url}/peers"
        try:
            close_client = False
            if client is None:
                client = httpx.AsyncClient(timeout=5.0)
                close_client = True
            try:
                res = await client.get(url)
                if res.status_code != 200:
                    logger.warning("[%s] Failed to fetch peers from CA: status %d", self.node_id, res.status_code)
                    return list(self.peers.values())

                data = res.json()
                discovered = data.get("peers", [])
                for p in discovered:
                    pid = p.get("peer_id")
                    if not pid or pid == self.node_id:
                        continue  # skip self or invalid

                    endpoint = self.resolve_endpoint(pid, p.get("endpoint"))
                    self.peers[pid] = {
                        "peer_id": pid,
                        "endpoint": endpoint,
                        "status": p.get("status", "ACTIVE"),
                        "serial_number": p.get("serial_number"),
                        "fingerprint_sha256": p.get("fingerprint_sha256"),
                        "registered_at": p.get("registered_at"),
                    }
                return list(self.peers.values())
            finally:
                if close_client:
                    await client.aclose()
        except Exception as e:
            logger.warning("[%s] CA peer discovery error: %s", self.node_id, e)
            return list(self.peers.values())

    async def fetch_peer_cert(self, peer_id: str, client: Optional[httpx.AsyncClient] = None) -> Optional[str]:
        """
        Fetch full X.509 certificate PEM for a peer directly from CA (GET /cert/{peer_id}).
        """
        url = f"{self.ca_url}/cert/{peer_id}"
        try:
            close_client = False
            if client is None:
                client = httpx.AsyncClient(timeout=5.0)
                close_client = True
            try:
                res = await client.get(url)
                if res.status_code != 200:
                    return None
                data = res.json()
                cert_pem = data.get("certificate_pem")
                if cert_pem:
                    self.peer_certs[peer_id] = cert_pem
                return cert_pem
            finally:
                if close_client:
                    await client.aclose()
        except Exception as e:
            logger.warning("[%s] Failed to fetch cert for peer '%s': %s", self.node_id, peer_id, e)
            return None

    def get_peer(self, peer_id: str) -> Optional[dict]:
        """Get cached peer info by ID."""
        return self.peers.get(peer_id)

    def get_peer_url(self, peer_id: str) -> Optional[str]:
        """Get resolved endpoint URL for peer_id."""
        peer = self.peers.get(peer_id)
        if peer:
            return peer.get("endpoint")
        return self.resolve_endpoint(peer_id)

    def set_peer_endpoint(self, peer_id: str, endpoint: str) -> None:
        """Manually override or record peer endpoint."""
        if peer_id not in self.peers:
            self.peers[peer_id] = {"peer_id": peer_id}
        self.peers[peer_id]["endpoint"] = endpoint.rstrip("/")

    def get_all_peers(self) -> List[dict]:
        """Return list of all known peers."""
        return list(self.peers.values())

