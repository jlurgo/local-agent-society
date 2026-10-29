"""Update notice: backend/updates.py says when the checkout is behind its
upstream, and `las claude`/`las start` print one line about it."""
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
import updates  # noqa: E402
from cli import update_notice  # noqa: E402


def _git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


def _commit(cwd, msg):
    _git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", msg)


@pytest.fixture
def checkout(tmp_path, monkeypatch):
    """A clone of an upstream repo; returns (clone, upstream)."""
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    _git(upstream, "init", "-q", "-b", "main")
    _commit(upstream, "first")
    clone = tmp_path / "clone"
    subprocess.run(["git", "clone", "-q", str(upstream), str(clone)], check=True)
    monkeypatch.setattr(updates, "REPO_DIR", clone)
    monkeypatch.setattr(updates, "_status", {"available": False, "behind": 0, "commits": [], "checked_at": None, "error": None})
    return clone, upstream


def test_up_to_date_checkout_has_no_update(checkout):
    s = updates.check_now()
    assert s["available"] is False and s["behind"] == 0 and s["error"] is None and s["checked_at"]


def test_new_upstream_commits_are_an_update_with_their_subjects(checkout):
    _, upstream = checkout
    _commit(upstream, "feat: speech bubbles")
    _commit(upstream, "fix: node 22")
    s = updates.check_now()
    assert s["available"] is True and s["behind"] == 2
    assert [c["subject"] for c in s["commits"]] == ["fix: node 22", "feat: speech bubbles"]
    assert updates.status() == s


def test_a_failed_fetch_keeps_the_last_answer(checkout):
    clone, upstream = checkout
    _commit(upstream, "new")
    assert updates.check_now()["behind"] == 1
    _git(clone, "remote", "set-url", "origin", str(upstream.parent / "gone"))
    s = updates.check_now()
    assert s["error"] and s["available"] is True and s["behind"] == 1


class _Resp:
    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


def test_notice_line_only_when_available(monkeypatch):
    monkeypatch.setattr(update_notice.requests, "get", lambda *a, **k: _Resp({"available": True, "behind": 3}))
    assert "3 new commits" in update_notice.update_notice() and "las update" in update_notice.update_notice()
    monkeypatch.setattr(update_notice.requests, "get", lambda *a, **k: _Resp({"available": False, "behind": 0}))
    assert update_notice.update_notice() is None


def test_notice_never_blocks_when_the_backend_is_down(monkeypatch):
    def boom(*a, **k):
        raise update_notice.requests.ConnectionError("down")
    monkeypatch.setattr(update_notice.requests, "get", boom)
    assert update_notice.update_notice() is None
