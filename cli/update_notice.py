"""One line when a newer LAS is published — printed as a session opens.

The backend already knows (backend/updates.py fetches the upstream in the
background), so asking it costs one local request; if it's down or slow the
notice is simply skipped, never in the way of opening a session.
"""
import sys

import requests

from cli.api import BASE


def update_notice() -> str | None:
    try:
        status = requests.get(f"{BASE}/update/status", timeout=1).json()
    except Exception:
        return None
    if not status.get("available"):
        return None
    n = status.get("behind", 0)
    return f"⬆  LAS update available — {n} new commit{'s' if n != 1 else ''}. Run `las update` when it suits you."


def print_update_notice() -> None:
    notice = update_notice()
    if notice:
        print(notice, file=sys.stderr)
