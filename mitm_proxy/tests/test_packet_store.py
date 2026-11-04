"""
Unit tests for MITM Proxy PacketStore (§9.1.1).
Validates Ring Buffer capacity, eviction, O(1) lookups, filtering, and sequential IDs.
"""
import pytest
from mitm_proxy.core.packet_store import PacketStore, PacketRecord


def create_sample_packet(packet_id: str, status: str = "FORWARDED", packet_type: str = "SECURE_MESSAGE") -> PacketRecord:
    return PacketRecord(
        packet_id=packet_id,
        timestamp="2026-11-04T12:00:00Z",
        direction="node_a → node_b",
        packet_type=packet_type,
        target_url="http://node_b:8002/message",
        raw_json={"type": packet_type, "from": "node_a", "to": "node_b", "msg": "hello"},
        status=status,
    )


def test_packet_id_generation():
    store = PacketStore(max_size=10)
    id1 = store.next_id()
    id2 = store.next_id()
    id3 = store.next_id()
    assert id1 == "pkt-001"
    assert id2 == "pkt-002"
    assert id3 == "pkt-003"


def test_add_and_get_packet():
    store = PacketStore(max_size=10)
    pkt = create_sample_packet("pkt-001")
    store.add_packet(pkt)

    retrieved = store.get_packet("pkt-001")
    assert retrieved is not None
    assert retrieved.packet_id == "pkt-001"
    assert retrieved.status == "FORWARDED"
    assert retrieved.packet_type == "SECURE_MESSAGE"

    assert store.get_packet("nonexistent") is None


def test_ring_buffer_eviction():
    max_size = 5
    store = PacketStore(max_size=max_size)

    # Add 7 packets (0 to 6)
    for i in range(7):
        pkt_id = f"pkt-{i:03d}"
        store.add_packet(create_sample_packet(pkt_id))

    assert store.count() == max_size
    # Oldest (pkt-000 and pkt-001) should have been evicted
    assert store.get_packet("pkt-000") is None
    assert store.get_packet("pkt-001") is None
    # Latest 5 should be present
    for i in range(2, 7):
        assert store.get_packet(f"pkt-{i:03d}") is not None


def test_filter_packets_by_status_and_type():
    store = PacketStore(max_size=20)
    store.add_packet(create_sample_packet("pkt-001", status="FORWARDED", packet_type="HANDSHAKE_INIT"))
    store.add_packet(create_sample_packet("pkt-002", status="HELD", packet_type="HANDSHAKE_INIT"))
    store.add_packet(create_sample_packet("pkt-003", status="FORWARDED", packet_type="SECURE_MESSAGE"))
    store.add_packet(create_sample_packet("pkt-004", status="TAMPERED", packet_type="SECURE_MESSAGE"))
    store.add_packet(create_sample_packet("pkt-005", status="HELD", packet_type="SECURE_FILE"))

    # Test status filter
    held_packets = store.get_packets(status="HELD")
    assert len(held_packets) == 2
    # Reverse order: pkt-005 then pkt-002
    assert [p.packet_id for p in held_packets] == ["pkt-005", "pkt-002"]

    # Test packet_type filter
    msg_packets = store.get_packets(packet_type="SECURE_MESSAGE")
    assert len(msg_packets) == 2
    assert [p.packet_id for p in msg_packets] == ["pkt-004", "pkt-003"]

    # Combined filter
    fwd_handshake = store.get_packets(status="FORWARDED", packet_type="HANDSHAKE_INIT")
    assert len(fwd_handshake) == 1
    assert fwd_handshake[0].packet_id == "pkt-001"


def test_get_latest_held_packet():
    store = PacketStore(max_size=10)
    assert store.get_latest_held_packet() is None

    store.add_packet(create_sample_packet("pkt-001", status="HELD"))
    store.add_packet(create_sample_packet("pkt-002", status="FORWARDED"))
    store.add_packet(create_sample_packet("pkt-003", status="HELD"))
    store.add_packet(create_sample_packet("pkt-004", status="FORWARDED"))

    latest_held = store.get_latest_held_packet()
    assert latest_held is not None
    assert latest_held.packet_id == "pkt-003"


def test_update_packet_record():
    store = PacketStore(max_size=10)
    pkt = create_sample_packet("pkt-001", status="HELD")
    store.add_packet(pkt)

    updated = store.update_packet("pkt-001", status="TAMPERED", attack_type="TAMPER_DATA")
    assert updated is not None
    assert updated.status == "TAMPERED"
    assert updated.attack_type == "TAMPER_DATA"

    # Verify lookup returns updated data
    retrieved = store.get_packet("pkt-001")
    assert retrieved.status == "TAMPERED"


def test_clear_packet_store():
    store = PacketStore(max_size=10)
    store.add_packet(create_sample_packet("pkt-001"))
    store.add_packet(create_sample_packet("pkt-002"))
    assert store.count() == 2

    store.clear()
    assert store.count() == 0
    assert store.get_packet("pkt-001") is None
    assert store.next_id() == "pkt-001"

