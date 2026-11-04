"""
Unit & Integration Tests for Peer Identity Management and CA Registration (§9.2.4).
"""
import sys
import shutil
import tempfile
from pathlib import Path

# Add project root and peer_node to path
BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent
for p in (str(REPO_ROOT), str(BASE_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import pytest
import httpx
from fastapi.testclient import TestClient

from ca_server.main import app as ca_app
from ca_server.core.certificate_store import CertificateStore
from peer_node.core.identity import IdentityManager
from peer_node.core.peer_discovery import PeerDiscovery
from shared.crypto_utils import generate_rsa_key_pair, public_key_to_pem


@pytest.fixture(scope="module")
def ca_setup():
    temp_dir = tempfile.mkdtemp(prefix="ca_test_identity_")
    store = CertificateStore(data_dir=Path(temp_dir))
    store.initialize(ca_name="CA_ROOT_TEST")
    ca_app.state.cert_store = store
    yield store
    shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
async def test_identity_keys_lifecycle():
    temp_dir = tempfile.mkdtemp(prefix="peer_id_test_")
    try:
        manager = IdentityManager(node_id="test_node_1", data_dir=temp_dir)
        manager.load_or_generate_keys(key_size=2048)

        assert manager.private_key is not None
        assert manager.public_key is not None
        assert manager.public_key_pem is not None
        assert (Path(temp_dir) / "private_key.pem").exists()
        assert (Path(temp_dir) / "public_key.pem").exists()

        # Reload keys
        manager2 = IdentityManager(node_id="test_node_1", data_dir=temp_dir)
        manager2.load_or_generate_keys()
        assert manager2.public_key_pem == manager.public_key_pem
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
async def test_identity_registration_with_ca(ca_setup):
    temp_dir = tempfile.mkdtemp(prefix="peer_id_reg_")
    try:
        # Use httpx.AsyncClient with ASGITransport for in-process testing
        transport = httpx.ASGITransport(app=ca_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testca") as client:
            manager = IdentityManager(node_id="node_a", data_dir=temp_dir)
            ok = await manager.initialize(
                ca_url="http://testca",
                endpoint="http://peer_a:8001",
                client=client,
            )

            assert ok is True
            assert manager.is_registered is True
            assert manager.certificate is not None
            assert manager.certificate_pem is not None
            assert manager.ca_cert is not None
            assert manager.ca_public_key is not None

            # Verify own cert using CA public key
            is_valid, reason = manager.verify_peer_certificate(manager.certificate_pem)
            assert is_valid is True
            assert "valid and trusted" in reason

            # Info reporting
            info = manager.get_identity_info()
            assert info["node_id"] == "node_a"
            assert info["is_registered"] is True
            assert info["ca_trusted"] is True
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.mark.anyio
async def test_peer_discovery(ca_setup):
    temp_dir_b = tempfile.mkdtemp(prefix="peer_id_b_")
    try:
        transport = httpx.ASGITransport(app=ca_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testca") as client:
            manager_b = IdentityManager(node_id="node_b", data_dir=temp_dir_b)
            await manager_b.initialize(ca_url="http://testca", endpoint="http://peer_b:8002", client=client)

            discovery = PeerDiscovery(node_id="node_a", ca_url="http://testca")
            peers = await discovery.fetch_peers(client=client)

            assert len(peers) >= 1
            peer_b = discovery.get_peer("node_b")
            assert peer_b is not None
            assert peer_b["endpoint"] == "http://peer_b:8002"

            # Check cert fetching
            cert_b = await discovery.fetch_peer_cert("node_b", client=client)
            assert cert_b is not None
            assert "-----BEGIN CERTIFICATE-----" in cert_b
    finally:
        shutil.rmtree(temp_dir_b, ignore_errors=True)
