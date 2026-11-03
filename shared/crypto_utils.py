"""
Common cryptographic utilities and helpers.
"""
from datetime import datetime, timezone


def get_utc_timestamp() -> str:
    """Return standard ISO-8601 UTC timestamp string."""
    return datetime.now(timezone.utc).isoformat()

