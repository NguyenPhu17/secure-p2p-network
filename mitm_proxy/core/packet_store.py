"""
In-memory Ring Buffer Packet Store for MITM Proxy.
Retains the most recent 500 intercepted packets with fast lookups, status tracking,
and filtering for the dashboard and attack engine (§9.1.1).
"""
import threading
from collections import deque
from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Any


@dataclass
class PacketRecord:
    packet_id: str
    timestamp: str
    direction: str
    packet_type: str
    target_url: str
    raw_json: Dict[str, Any]
    status: str  # "HELD", "FORWARDED", "TAMPERED", "REPLAYED", "SPOOFED", "DROPPED"
    raw_headers: Dict[str, str] = field(default_factory=dict)
    modified_json: Optional[Dict[str, Any]] = None
    receiver_response: Optional[Dict[str, Any]] = None
    forwarded_at: Optional[str] = None
    attack_type: Optional[str] = None
    attack_details: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class PacketStore:
    def __init__(self, max_size: int = 500):
        self.max_size = max_size
        self._counter: int = 0
        self._buffer: deque[PacketRecord] = deque()
        self._by_id: Dict[str, PacketRecord] = {}
        self._lock = threading.Lock()

    def next_id(self) -> str:
        """Generate a sequential human-friendly packet identifier (e.g. pkt-001)."""
        with self._lock:
            self._counter += 1
            return f"pkt-{self._counter:03d}"

    def add_packet(self, packet: PacketRecord) -> PacketRecord:
        """Add packet record to ring buffer; evict oldest packet if capacity reached."""
        with self._lock:
            if len(self._buffer) >= self.max_size:
                evicted = self._buffer.popleft()
                self._by_id.pop(evicted.packet_id, None)

            self._buffer.append(packet)
            self._by_id[packet.packet_id] = packet
            return packet

    def get_packet(self, packet_id: str) -> Optional[PacketRecord]:
        """Retrieve a packet record by its ID in O(1) time."""
        with self._lock:
            return self._by_id.get(packet_id)

    def get_packets(
        self,
        status: Optional[str] = None,
        packet_type: Optional[str] = None,
        limit: int = 50,
    ) -> List[PacketRecord]:
        """
        Query captured packets ordered from newest to oldest.
        Supports filtering by status (HELD, FORWARDED, etc.) and packet_type.
        """
        with self._lock:
            results: List[PacketRecord] = []
            # Traverse reverse order (newest first)
            for pkt in reversed(self._buffer):
                if status and pkt.status.upper() != status.upper():
                    continue
                if packet_type and pkt.packet_type.upper() != packet_type.upper():
                    continue
                results.append(pkt)
                if len(results) >= limit:
                    break
            return results

    def get_latest_held_packet(self) -> Optional[PacketRecord]:
        """Get the most recent packet currently in HELD state."""
        with self._lock:
            for pkt in reversed(self._buffer):
                if pkt.status.upper() == "HELD":
                    return pkt
            return None

    def get_latest_packet(
        self,
        packet_type: Optional[str] = None,
    ) -> Optional[PacketRecord]:
        """Get the most recent packet, optionally matching a packet type."""
        with self._lock:
            for pkt in reversed(self._buffer):
                if packet_type is None or pkt.packet_type.upper() == packet_type.upper():
                    return pkt
            return None

    def update_packet(self, packet_id: str, **kwargs) -> Optional[PacketRecord]:
        """Update fields on an existing packet record."""
        with self._lock:
            pkt = self._by_id.get(packet_id)
            if not pkt:
                return None
            for key, val in kwargs.items():
                if hasattr(pkt, key):
                    setattr(pkt, key, val)
            return pkt

    def count(self) -> int:
        """Return total number of packets currently stored."""
        with self._lock:
            return len(self._buffer)

    def held_count(self) -> int:
        """Return number of packets currently held."""
        with self._lock:
            return sum(1 for pkt in self._buffer if pkt.status.upper() == "HELD")

    def clear(self) -> None:
        """Clear all stored packets and reset counter."""
        with self._lock:
            self._buffer.clear()
            self._by_id.clear()
            self._counter = 0

