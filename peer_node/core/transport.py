"""
HTTP Transport & Routing for Peer-to-Peer Communication.
Handles transparent routing through MITM Proxy (X-Target-URL) with direct fallback (§9.1.1).
"""
import logging
from typing import Optional, Tuple, Dict, Any
import httpx

logger = logging.getLogger("peer_node.transport")


async def send_peer_packet(
    target_url: str,
    payload: dict,
    proxy_url: Optional[str] = None,
    client: Optional[httpx.AsyncClient] = None,
    timeout: float = 10.0,
) -> Tuple[int, Dict[str, Any]]:
    """
    Send packet to target peer, routing through MITM Proxy if configured.
    Returns (status_code: int, response_json: dict).
    """
    close_client = False
    if client is None:
        client = httpx.AsyncClient(timeout=timeout)
        close_client = True

    try:
        # 1. Try through Proxy if configured
        if proxy_url and proxy_url.strip():
            proxy_endpoint = f"{proxy_url.rstrip('/')}/forward"
            headers = {
                "X-Target-URL": target_url,
                "Content-Type": "application/json",
            }
            try:
                logger.debug("Routing packet via MITM proxy %s -> %s", proxy_endpoint, target_url)
                res = await client.post(proxy_endpoint, json=payload, headers=headers)
                try:
                    return res.status_code, res.json()
                except Exception:
                    return res.status_code, {"text": res.text}
            except (httpx.ConnectError, httpx.TimeoutException) as proxy_err:
                logger.warning("Proxy at %s unreachable (%s), falling back to direct connection to %s", proxy_url, proxy_err, target_url)

        # 2. Direct delivery (fallback or proxy disabled)
        logger.debug("Sending direct packet to %s", target_url)
        res = await client.post(target_url, json=payload)
        try:
            return res.status_code, res.json()
        except Exception:
            return res.status_code, {"text": res.text}

    finally:
        if close_client:
            await client.aclose()

