import os

PORT = int(os.getenv("PORT", "8080"))
HOST = os.getenv("HOST", "0.0.0.0")
CA_URL = os.getenv("CA_URL", "http://ca_server:8000")

