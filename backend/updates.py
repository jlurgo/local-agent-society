"""Update notice: is this checkout behind its upstream?

Every machine runs LAS from a git checkout (`las update` = git pull +
install.sh), so "an update exists" means the upstream branch has commits
this checkout doesn't. A background thread fetches every CHECK_INTERVAL_S
and keeps the answer in memory; GET /update/status serves it without
touching the network, so the widget can poll it and `las claude` /
`las start` can print it at no cost.
"""
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

from logging_config import logger

REPO_DIR = Path(__file__).resolve().parent.parent
CHECK_INTERVAL_S = 15 * 60
FIRST_CHECK_DELAY_S = 10
MAX_SUBJECTS = 8

_lock = threading.Lock()
_status: dict = {"available": False, "behind": 0, "commits": [], "checked_at": None, "error": None}


def _git(*args: str, timeout: float = 30) -> str:
    return subprocess.run(["git", "-C", str(REPO_DIR), *args], capture_output=True, text=True,
                          timeout=timeout, check=True).stdout.strip()


def check_now() -> dict:
    """Fetch the upstream and recompute the status. Never raises."""
    try:
        upstream = _git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
        remote, _, branch = upstream.partition("/")
        _git("fetch", "-q", remote, branch, timeout=60)
        behind = int(_git("rev-list", "--count", f"HEAD..{upstream}") or 0)
        log = _git("log", f"--max-count={MAX_SUBJECTS}", "--format=%h%x09%s", f"HEAD..{upstream}") if behind else ""
        commits = [dict(zip(("sha", "subject"), line.split("\t", 1))) for line in log.splitlines()]
        new = {"available": behind > 0, "behind": behind, "commits": commits, "error": None}
    except Exception as exc:  # offline, no upstream, git missing — keep the last answer
        err = getattr(exc, "stderr", None) or str(exc)
        new = {"error": err.strip()[:300]}
    with _lock:
        was_behind = _status["behind"]
        _status.update(new, checked_at=datetime.now().isoformat(timespec="seconds"))
        snapshot = dict(_status)
    if snapshot["error"]:
        logger.warning(f"[update] check failed: {snapshot['error']}")
    elif snapshot["behind"] != was_behind:
        logger.info(f"[update] {snapshot['behind']} commit(s) behind upstream")
    return snapshot


def status() -> dict:
    with _lock:
        return dict(_status)


def _loop() -> None:
    time.sleep(FIRST_CHECK_DELAY_S)
    while True:
        check_now()
        time.sleep(CHECK_INTERVAL_S)


def start() -> None:
    threading.Thread(target=_loop, name="update-check", daemon=True).start()
