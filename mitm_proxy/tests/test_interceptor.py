"""
Unit tests for MITM Proxy Interceptor (§9.1.1).
Tests Passthrough and Hold modes, release mechanism, and timeout behavior.
"""
import asyncio
import json
import pytest
import httpx
from mitm_proxy.core.packet_store import PacketStore
from mitm_proxy.core.interceptor import Interceptor


def test_interceptor_mode_switching():
    store = PacketStore()
    interceptor = Interceptor(packet_store=store)

    assert interceptor.mode == "passthrough"

    interceptor.set_mode("hold")
    assert interceptor.mode == "hold"

    interceptor.set_mode("intercept")
    assert interceptor.mode == "hold"

    interceptor.set_mode("passthrough")
    assert interceptor.mode == "passthrough"

    with pytest.raises(ValueError):
        interceptor.set_mode("invalid_mode")


@pytest.mark.anyio
async def test_passthrough_mode_forwarding():
    store = PacketStore()
    events = []

    async def mock_broadcast(event):
        events.append(event)

    # Mock destination transport
    async def mock_server(request: httpx.Request):
        assert request.url == "http://target_node:8002/message"
        body = json.loads(request.read())
        assert body["text"] == "hello"
        return httpx.Response(200, json={"status": "OK", "received": True})

    client = httpx.AsyncClient(transport=httpx.MockTransport(mock_server))
    interceptor = Interceptor(
        packet_store=store,
        broadcast_func=mock_broadcast,
        default_mode="passthrough",
        http_client=client,
    )

    payload = json.dumps({"type": "SECURE_MESSAGE", "from": "node_a", "to": "node_b", "text": "hello"}).encode("utf-8")
    status_code, res_body, _ = await interceptor.handle_forward(
        target_url="http://target_node:8002/message",
        body_bytes=payload,
        headers={"Content-Type": "application/json", "X-Target-URL": "http://target_node:8002/message"},
    )

    assert status_code == 200
    assert res_body["status"] == "OK"
    assert store.count() == 1

    packet = store.get_packet("pkt-001")
    assert packet is not None
    assert packet.status == "FORWARDED"
    assert packet.packet_type == "SECURE_MESSAGE"
    assert packet.direction == "node_a → node_b"

    # Event broadcasted
    assert len(events) == 1
    assert events[0]["event"] == "PACKET_INTERCEPTED"
    assert events[0]["status"] == "FORWARDED"

    await client.aclose()


@pytest.mark.anyio
async def test_hold_mode_and_release():
    store = PacketStore()
    events = []

    async def mock_broadcast(event):
        events.append(event)

    async def mock_server(request: httpx.Request):
        return httpx.Response(200, json={"status": "RECEIVED_AFTER_RELEASE"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(mock_server))
    interceptor = Interceptor(
        packet_store=store,
        broadcast_func=mock_broadcast,
        default_mode="hold",
        hold_timeout=5.0,
        http_client=client,
    )

    payload = json.dumps({"type": "SECURE_MESSAGE", "from": "node_a", "to": "node_b"}).encode("utf-8")

    # Start forward task in background (will block because mode is "hold")
    forward_task = asyncio.create_task(
        interceptor.handle_forward(
            target_url="http://target_node:8002/message",
            body_bytes=payload,
            headers={"Content-Type": "application/json"},
        )
    )

    # Allow task to progress into hold state
    await asyncio.sleep(0.05)
    assert interceptor.held_count() == 1
    assert interceptor.is_held("pkt-001")

    pkt = store.get_packet("pkt-001")
    assert pkt.status == "HELD"

    # Broadcast should have reported HELD
    assert len(events) == 1
    assert events[0]["status"] == "HELD"

    # Operator triggers release
    ok, msg, released_pkt = interceptor.release_held_packet("pkt-001")
    assert ok
    assert released_pkt.packet_id == "pkt-001"

    # Forward task completes now
    status_code, res_body, _ = await forward_task
    assert status_code == 200
    assert res_body["status"] == "RECEIVED_AFTER_RELEASE"
    assert interceptor.held_count() == 0

    await client.aclose()


@pytest.mark.anyio
async def test_hold_mode_timeout():
    store = PacketStore()

    client = httpx.AsyncClient()
    interceptor = Interceptor(
        packet_store=store,
        default_mode="hold",
        hold_timeout=0.1,  # Short timeout for testing
        http_client=client,
    )

    payload = json.dumps({"type": "SECURE_MESSAGE"}).encode("utf-8")
    status_code, res_body, _ = await interceptor.handle_forward(
        target_url="http://target_node:8002/message",
        body_bytes=payload,
        headers={},
    )

    assert status_code == 504
    assert res_body["error_code"] == "E_HELD_TIMEOUT"

    pkt = store.get_packet("pkt-001")
    assert pkt.status == "TIMEOUT"

    await client.aclose()

