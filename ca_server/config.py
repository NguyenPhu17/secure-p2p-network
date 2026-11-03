import os
from pathlib import Path

NODE_ID = os.getenv("NODE_ID", "CA_ROOT")
PORT = int(os.getenv("PORT", "8000"))
HOST = os.getenv("HOST", "0.0.0.0")

# Data directory for storing certs and keys
DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

