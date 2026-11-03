import os
from pathlib import Path

NODE_ID = os.getenv("NODE_ID", "node_a")
PORT = int(os.getenv("PORT", "8001"))
HOST = os.getenv("HOST", "0.0.0.0")

CA_URL = os.getenv("CA_URL", "http://ca_server:8000")
PROXY_URL = os.getenv("PROXY_URL", "http://mitm_proxy:8080")

DATA_DIR = Path(os.getenv("DATA_DIR", f"./data/{NODE_ID}"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

