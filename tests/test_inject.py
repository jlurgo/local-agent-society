#!/usr/bin/env python3
"""
Tests for POST /agents/{name}/inject and the vortexia messaging path
(GET /agents/{name}/vortexia/poll, POST /agents/{name}/vortexia/register).

Inject used to type directly into a disposable iTerm2/AppleScript probe
terminal — that mechanism is gone. Delivery is now 100% vortexia (a
sibling MQTT broker, see ../vortexia/PROTOCOL.md): /inject publishes an
envelope to las/agent/<name>/inbox, where the broker's per-agent mailbox
(MQTT persistent session, vortexia PROTOCOL.md "Mailboxes") queues it until
the receiver's poll_inbox()/listen consumes it.

These tests run against the real, live backend at localhost:8700 and
(for the delivery test) the real vortexia broker it talks to — nothing is
mocked. If vortexia isn't running, the delivery test is skipped rather
than failed, since the backend is documented to fail soft in that case.

Usage: python3 tests/test_inject.py  (or via pytest)
"""
import json
import sys
import threading
import time
import urllib.error
import urllib.request

BACKEND = "http://localhost:8700"
SENDER_NAME   = "__e2e_inject_sender__"
RECEIVER_NAME = "__e2e_inject_receiver__"
PASS = 0
FAIL = 0


def ok(name: str):
    global PASS
    PASS += 1
    print(f"  PASS {name}")


def fail(name: str, reason: str):
    global FAIL
    FAIL += 1
    print(f"  FAIL {name}: {reason}")


def post(path: str, body: dict, timeout: int = 5) -> tuple[int, dict]:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BACKEND}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def get(path: str, timeout: int = 8) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(f"{BACKEND}{path}", timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def delete(path: str, timeout: int = 5) -> int:
    req = urllib.request.Request(f"{BACKEND}{path}", method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except Exception:
        return 0


def _backend_reachable() -> bool:
    try:
        with urllib.request.urlopen(f"{BACKEND}/health", timeout=3):
            return True
    except Exception:
        return False


def setup_probes():
    for name in (SENDER_NAME, RECEIVER_NAME):
        status, _ = post("/agents", {"name": name, "voice": "Samantha", "path": f"/tmp/{name}"})
        if status != 200:
            raise RuntimeError(f"failed to register probe agent {name!r}: HTTP {status}")


def teardown_probes():
    delete(f"/agents/{SENDER_NAME}")
    delete(f"/agents/{RECEIVER_NAME}")


# ── tests ─────────────────────────────────────────────────────────────────────

def test_unknown_agent_returns_404():
    status, _ = post("/agents/__nonexistent_agent__/inject", {"message": "test"})
    if status == 404:
        ok("unknown agent → 404")
    else:
        fail("unknown agent → 404", f"got {status}")


def test_inject_response_shape():
    status, body = post(f"/agents/{RECEIVER_NAME}/inject", {"message": "shape test"})
    if status != 200:
        fail("response shape", f"HTTP {status}")
        return
    for key in ("ok", "injected", "via"):
        if key not in body:
            fail("response shape", f"missing field '{key}'")
            return
    if body.get("via") != "vortexia":
        fail("response shape", f"expected via='vortexia', got {body.get('via')!r}")
        return
    if "tty" in body:
        fail("response shape", "tty field should not exist — TTY injection was removed")
        return
    ok("response contains ok, injected, via=vortexia (no tty)")


def test_voice_source_returns_ok():
    status, body = post(f"/agents/{RECEIVER_NAME}/inject", {"message": "__voice_test__", "source": "voice"})
    if status == 200 and body.get("ok"):
        ok("voice source inject returns ok=true")
    else:
        fail("voice source inject returns ok=true", f"HTTP {status} body={body}")


def test_agent_source_returns_ok():
    status, body = post(
        f"/agents/{RECEIVER_NAME}/inject",
        {"message": "__agent_test__", "source": "agent", "from_agent": SENDER_NAME},
    )
    if status == 200 and body.get("ok"):
        ok("agent source inject returns ok=true")
    else:
        fail("agent source inject returns ok=true", f"HTTP {status} body={body}")


def test_newlines_in_message_dont_crash():
    status, _ = post(f"/agents/{RECEIVER_NAME}/inject", {"message": "line1\nline2\r\nline3"})
    if status in (200, 422):
        ok("newlines in message don't cause 500")
    else:
        fail("newlines in message don't cause 500", f"HTTP {status}")


def test_empty_message_rejected():
    # A blank message used to be delivered as an empty event the recipient
    # couldn't act on; now the sender gets a 422 and knows nothing went out.
    for msg in ("", "  \n"):
        status, _ = post(f"/agents/{RECEIVER_NAME}/inject", {"message": msg})
        if status == 422:
            ok(f"blank message {msg!r} rejected with 422")
        else:
            fail(f"blank message {msg!r} rejected with 422", f"HTTP {status}")


def test_oversized_message_rejected():
    status, _ = post(f"/agents/{RECEIVER_NAME}/inject", {"message": "x" * 20000})
    if status == 422:
        ok("oversized message rejected with 422")
    else:
        fail("oversized message rejected with 422", f"HTTP {status}")


def test_message_actually_arrives_via_vortexia():
    """The strongest e2e check: publish while the receiver is polling and
    confirm the exact envelope shows up — real MQTT round-trip, nothing
    mocked. Requires vortexia to actually be running; skipped otherwise."""
    marker = f"__e2e_marker_{int(time.time() * 1000)}__"
    result_holder: dict = {}

    def do_poll():
        status, body = get(f"/agents/{RECEIVER_NAME}/vortexia/poll?timeout=3")
        result_holder["status"] = status
        result_holder["body"] = body

    t = threading.Thread(target=do_poll)
    t.start()
    time.sleep(0.4)  # let the poll subscribe before we publish
    inject_status, inject_body = post(
        f"/agents/{RECEIVER_NAME}/inject",
        {"message": marker, "source": "agent", "from_agent": SENDER_NAME},
    )
    t.join(timeout=5)

    if not inject_body.get("injected"):
        fail("message arrives via vortexia (real round-trip)",
             "inject reported injected=false — is vortexia running? (`vortexia start` in the vortexia repo)")
        return

    messages = result_holder.get("body", {}).get("messages", [])
    matches = [m for m in messages if m.get("text") == marker]
    if not matches:
        fail("message arrives via vortexia (real round-trip)", f"marker not found in polled messages: {messages}")
        return
    m = matches[0]
    if m.get("from") == SENDER_NAME and m.get("to") == RECEIVER_NAME:
        ok("message actually arrived via vortexia (real MQTT round-trip, envelope verified)")
    else:
        fail("message arrives via vortexia (real round-trip)", f"envelope fields wrong: {m}")


def test_register_sets_presence_online():
    status, body = post(f"/agents/{SENDER_NAME}/vortexia/register", {})
    if status == 200 and "registered" in body:
        ok("vortexia/register returns registered field")
    else:
        fail("vortexia/register returns registered field", f"HTTP {status} body={body}")


def test_audit_log_records_via_vortexia():
    import tempfile
    from pathlib import Path

    tmp = Path(tempfile.mkdtemp(prefix="e2e_inject_audit_"))
    (tmp / "session").mkdir()
    audit_name = "__e2e_inject_audit__"
    post("/agents", {"name": audit_name, "voice": "Samantha", "path": str(tmp)})
    try:
        marker = "__audit_marker__"
        status, body = post(f"/agents/{audit_name}/inject", {"message": marker, "source": "raw"})
        if status != 200:
            fail("audit log records via=vortexia", f"HTTP {status} body={body}")
            return
        log_path = tmp / "session" / "inject.log"
        if not log_path.exists():
            fail("audit log records via=vortexia", "inject.log not written")
            return
        text = log_path.read_text()
        if "via=vortexia" in text and f"msg={marker!r}" in text:
            ok("inject.log records via=vortexia delivery")
        else:
            fail("audit log records via=vortexia", f"unexpected log contents: {text!r}")
    finally:
        delete(f"/agents/{audit_name}")


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    print("=== Inject / vortexia messaging tests ===\n")
    if not _backend_reachable():
        print("FAIL  backend unreachable at", BACKEND)
        sys.exit(1)

    test_unknown_agent_returns_404()

    print("\n→ Registering disposable probe agents (torn down at the end)...")
    setup_probes()
    try:
        test_inject_response_shape()
        test_voice_source_returns_ok()
        test_agent_source_returns_ok()
        test_newlines_in_message_dont_crash()
        test_empty_message_rejected()
        test_oversized_message_rejected()
        test_register_sets_presence_online()
        test_message_actually_arrives_via_vortexia()
        test_audit_log_records_via_vortexia()
    finally:
        print("\n→ Unregistering probe agents...")
        teardown_probes()

    print(f"\n══════════════════════════════════")
    print(f"Results: {PASS} passed, {FAIL} failed")
    print(f"══════════════════════════════════")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
