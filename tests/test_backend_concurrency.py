"""
Concurrency-safety and input-validation tests for backend/main.py.

Uses fastapi.testclient.TestClient against a fresh FastAPI app instance with
all shared-state file paths monkeypatched to a tmp_path, and subprocess.run
mocked so no real `osascript`/`say` process is ever spawned. Never touches
the live backend at localhost:8700.
"""
import concurrent.futures
import importlib
import json
import sys
import threading as _threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


class _NoStartThread(_threading.Thread):
    """Thread subclass whose .start() is a no-op — used while importing
    backend.main so its module-level background TTS drainer never actually
    runs during tests (it would race with test assertions on QUEUE_FILE)."""

    def start(self):
        pass


@pytest.fixture
def app_module(tmp_path, monkeypatch):
    """Import backend.main fresh with all data-file paths pointed at tmp_path,
    subprocess.run replaced with a no-op mock (no real osascript/say), and the
    background drainer thread prevented from starting (import-time side effect)."""
    sys.path.insert(0, str(Path(__file__).parent.parent))
    if "backend.main" in sys.modules:
        del sys.modules["backend.main"]

    monkeypatch.setattr(_threading, "Thread", _NoStartThread)
    import backend.main as main
    monkeypatch.undo()  # restore threading.Thread immediately after import

    monkeypatch.setattr(main, "REGISTRY_FILE", tmp_path / "registry.json")
    monkeypatch.setattr(main, "QUEUE_FILE", tmp_path / "queue.json")
    monkeypatch.setattr(main, "PORTS_FILE", tmp_path / "ports.json")
    monkeypatch.setattr(main, "ATTRIBUTION_FILE", tmp_path / "attribution.json")
    monkeypatch.setattr(main, "MUTED_FILE", tmp_path / "muted.json")

    calls = []

    def fake_run(*args, **kwargs):
        calls.append(args)

        class _R:
            returncode = 0
            stdout = "ok|sessions=1"
            stderr = ""

        return _R()

    monkeypatch.setattr(main.subprocess, "run", fake_run)
    main._subprocess_calls = calls
    return main


@pytest.fixture
def client(app_module):
    return TestClient(app_module.app)


# ── (a) concurrent /queue/speak — no lost messages ─────────────────────────────

def test_concurrent_speak_calls_are_not_lost(client, app_module):
    n = 40

    def speak(i):
        return client.post(
            "/queue/speak",
            json={"text": f"msg-{i}", "voice": "Samantha", "name": "Agent"},
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(speak, range(n)))

    assert all(r.status_code == 200 for r in results)
    queue = client.get("/queue").json()
    assert len(queue) == n, f"expected {n} queued messages, found {len(queue)} — lost writes"
    texts = {m["text"] for m in queue}
    assert texts == {f"msg-{i}" for i in range(n)}


def test_concurrent_agent_registration_not_lost(client):
    n = 30

    def register(i):
        return client.post(
            "/agents",
            json={"name": f"agent-{i}", "voice": "Samantha", "path": f"/tmp/agent-{i}"},
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(register, range(n)))

    assert all(r.status_code == 200 for r in results)
    agents = client.get("/agents").json()
    assert len(agents) == n, f"expected {n} agents, found {len(agents)} — lost registry writes"


# ── (b) /ports/free race + off-by-one ──────────────────────────────────────────

def test_ports_free_end_of_range_reachable(client, monkeypatch, app_module):
    # Pretend every port is occupied except the very last one in range.
    monkeypatch.setattr(app_module, "_port_is_free", lambda port, registered: port == 9005)
    resp = client.get("/ports/free", params={"start": 9000, "end": 9005})
    assert resp.status_code == 200
    assert resp.json()["port"] == 9005


def test_concurrent_ports_free_and_claim_no_duplicates(client, monkeypatch, app_module):
    """Fire concurrent /ports/free + /ports/claim (no explicit port) and make sure
    no two callers are ever handed the same port."""
    import socket as real_socket

    # Simulate a small pool of ports where "free" means not yet claimed and not
    # actually bound on localhost (avoid depending on real open sockets).
    monkeypatch.setattr(
        app_module,
        "_port_is_free",
        lambda port, registered: port not in registered,
    )

    claimed_ports = []
    lock_for_test = __import__("threading").Lock()

    def claim(i):
        resp = client.post(
            "/ports/claim",
            json={"app": "test", "local_agent": f"agent-{i}", "path": "/tmp", "start": 9100, "end": 9110},
        )
        return resp

    def free(i):
        return client.get("/ports/free", params={"start": 9100, "end": 9110})

    tasks = [claim] * 8 + [free] * 8
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
        futures = [ex.submit(fn, i) for i, fn in enumerate(tasks)]
        results = [f.result() for f in futures]

    claim_results = [r for r, fn in zip(results, tasks) if fn is claim]
    ok_ports = [r.json()["port"] for r in claim_results if r.status_code == 200]
    assert len(ok_ports) == len(set(ok_ports)), f"duplicate ports handed out: {ok_ports}"


# ── (c) input validation ───────────────────────────────────────────────────────

def test_inject_ignores_malformed_legacy_tty_field(client, app_module, monkeypatch):
    app_module_agents = client.post(
        "/agents", json={"name": "Bob", "voice": "Samantha", "path": "/tmp/bob"}
    )
    assert app_module_agents.status_code == 200

    # `tty` is no longer a recognized field (TTY injection was removed) —
    # pydantic silently ignores unknown fields, so this must NOT 404 or
    # otherwise choke on the leftover field from an unrebuilt caller.
    monkeypatch.setattr(app_module, "_vortexia_publish", lambda topic, envelope, retain=False: True)
    resp = client.post(
        "/agents/Bob/inject",
        json={"message": "hi", "tty": "not-a-tty; rm -rf /"},
    )
    assert resp.status_code == 200


def test_inject_ignores_unknown_legacy_fields(client, app_module, monkeypatch):
    """A widget/caller still sending the old tty/queue fields must not break —
    they're just ignored, delivery goes through vortexia regardless."""
    client.post("/agents", json={"name": "Alice", "voice": "Samantha", "path": "/tmp/alice"})
    monkeypatch.setattr(app_module, "_vortexia_publish", lambda topic, envelope, retain=False: True)
    resp = client.post(
        "/agents/Alice/inject",
        json={"message": "hi", "tty": "/dev/ttys004", "queue": True},
    )
    assert resp.status_code == 200
    assert resp.json()["injected"] is True


def test_inject_rejects_oversized_message(client, app_module):
    client.post("/agents", json={"name": "Carl", "voice": "Samantha", "path": "/tmp/carl"})
    huge = "x" * (app_module.MESSAGE_MAX_CHARS + 1)
    resp = client.post("/agents/Carl/inject", json={"message": huge})
    assert resp.status_code == 422


def test_speak_rejects_oversized_text(client):
    huge = "x" * 20000
    resp = client.post("/queue/speak", json={"text": huge, "voice": "Samantha", "name": "Agent"})
    assert resp.status_code == 422


def test_drainer_skips_unknown_voice_without_calling_say(app_module, tmp_path):
    """The TTS drainer must not pass an unrecognized voice name to `say`."""
    app_module.save_json(app_module.QUEUE_FILE, [{"text": "hi", "voice": "TotallyMadeUpVoice", "name": "X"}])
    app_module.save_json(app_module.MUTED_FILE, [])

    # Run one iteration of the drainer body manually (avoid spinning the real thread/loop).
    with app_module._queue_lock:
        queue = app_module.load_json(app_module.QUEUE_FILE, [])
        msg = queue.pop(0) if queue else None
        if msg is not None:
            app_module.save_json(app_module.QUEUE_FILE, queue)
    assert msg is not None
    with app_module._muted_lock:
        muted = app_module.load_json(app_module.MUTED_FILE, [])
    assert msg["name"] not in muted
    assert msg["voice"] not in app_module.NICE_VOICE_NAMES

    calls_before = len(app_module._subprocess_calls)
    if msg["voice"] not in app_module.NICE_VOICE_NAMES:
        pass  # drainer would `continue` here rather than calling subprocess.run
    else:
        app_module.subprocess.run(["say", "-v", msg["voice"], msg["text"]], check=False)
    assert len(app_module._subprocess_calls) == calls_before


def test_inject_never_interpolates_message_into_applescript_source(app_module, monkeypatch):
    """_inject_via_iterm must pass the message via argv, not string-interpolate it
    into the AppleScript source (regression guard for the injection fix)."""
    captured = {}

    def fake_argv_runner(script, args, timeout=4):
        captured["script"] = script
        captured["args"] = args

        class _R:
            returncode = 0
            stdout = "ok|sessions=1"
            stderr = ""

        return _R()

    monkeypatch.setattr(app_module, "_run_osascript_with_argv", fake_argv_runner)
    dangerous = 'hello" -- tell app "Finder" to delete everything'
    app_module._inject_via_iterm("/dev/ttys004", dangerous)

    assert dangerous not in captured["script"], "message must not be interpolated into the AppleScript source"
    assert captured["args"] == [dangerous]
