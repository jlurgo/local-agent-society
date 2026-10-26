"""
Comprehensive endpoint coverage for backend/main.py.

Uses fastapi.testclient.TestClient against the real app (backend.main), with
all shared-state file paths monkeypatched to a tmp_path, and subprocess.run
mocked so no real `osascript`/`say` process is ever spawned. Never touches
the live backend at localhost:8700.

This file covers routes NOT already exercised by test_backend_concurrency.py
or test_cli_agents.py: full agents CRUD (incl. rename/focus/ttys/terminal/
pending/mute), voices, widget HTML, attribution, queue, ports, and the
drag-to-link pin-tty / pending-link pair.
"""
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
        calls.append((args, kwargs))

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


def register(client, name="Alice", voice="Samantha", path="/tmp/alice"):
    return client.post("/agents", json={"name": name, "voice": voice, "path": path})


# ── agents: create / list / duplicate ──────────────────────────────────────────

def test_register_and_list_agent(client):
    resp = register(client)
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "name": "Alice"}

    agents = client.get("/agents").json()
    assert "Alice" in agents
    assert agents["Alice"]["voice"] == "Samantha"
    assert agents["Alice"]["path"] == "/tmp/alice"
    assert agents["Alice"]["backend_url"] == "http://localhost:8700"
    assert agents["Alice"]["frontend_url"] == "http://localhost:8700/widget/Alice"
    assert "registered_at" in agents["Alice"]


def test_register_duplicate_name_overwrites_not_rejected(client):
    """POST /agents is upsert-by-name (no explicit duplicate-rejection route);
    posting the same name twice must not error and the latest data wins."""
    r1 = register(client, path="/tmp/alice-v1")
    r2 = register(client, path="/tmp/alice-v2")
    assert r1.status_code == 200
    assert r2.status_code == 200
    agents = client.get("/agents").json()
    assert agents["Alice"]["path"] == "/tmp/alice-v2"


# ── agents: rename (PATCH) ──────────────────────────────────────────────────────

def test_rename_agent_valid(client):
    register(client, name="Bob")
    resp = client.patch("/agents/Bob", json={"new_name": "Robert"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "old_name": "Bob", "new_name": "Robert"}

    agents = client.get("/agents").json()
    assert "Bob" not in agents
    assert "Robert" in agents
    assert agents["Robert"]["frontend_url"] == "http://localhost:8700/widget/Robert"


def test_rename_agent_missing_name_404(client):
    resp = client.patch("/agents/DoesNotExist", json={"new_name": "Whatever"})
    assert resp.status_code == 404


def test_rename_agent_empty_new_name_422(client):
    register(client, name="Carl")
    resp = client.patch("/agents/Carl", json={"new_name": "   "})
    assert resp.status_code == 422


def test_rename_agent_collision_409(client):
    register(client, name="Dan")
    register(client, name="Eve")
    resp = client.patch("/agents/Dan", json={"new_name": "Eve"})
    assert resp.status_code == 409


def test_rename_agent_to_same_name_allowed(client):
    register(client, name="Frank")
    resp = client.patch("/agents/Frank", json={"new_name": "Frank"})
    assert resp.status_code == 200


def test_rename_updates_pronunciation_when_it_matched_old_name(client):
    client.post(
        "/agents",
        json={"name": "Gina", "voice": "Samantha", "path": "/tmp/gina", "pronunciation": "Gina"},
    )
    resp = client.patch("/agents/Gina", json={"new_name": "Regina"})
    assert resp.status_code == 200
    agents = client.get("/agents").json()
    assert agents["Regina"]["pronunciation"] == "Regina"


# ── agents: delete ──────────────────────────────────────────────────────────────

def test_delete_agent(client):
    register(client, name="Hank")
    resp = client.delete("/agents/Hank")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert "Hank" not in client.get("/agents").json()


def test_delete_missing_agent_404(client):
    resp = client.delete("/agents/Ghost")
    assert resp.status_code == 404


# ── agents: focus ────────────────────────────────────────────────────────────────

def test_focus_agent_not_found_404(client):
    resp = client.post("/agents/Ghost/focus")
    assert resp.status_code == 404


def test_focus_agent_success(client, app_module, monkeypatch):
    register(client, name="Ivy", path="/tmp/ivy")
    monkeypatch.setattr(app_module, "_find_all_claude_ttys", lambda path: ["ttys004"])
    monkeypatch.setattr(
        app_module, "_focus_via_iterm",
        lambda tty: {"success": True, "tty": "/dev/ttys004", "stdout": "ok"},
    )
    resp = client.post("/agents/Ivy/focus")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["focused"] is True
    assert body["tty"] == "/dev/ttys004"


def test_focus_agent_no_ttys_found(client, app_module, monkeypatch):
    register(client, name="Jack", path="/tmp/jack")
    monkeypatch.setattr(app_module, "_find_all_claude_ttys", lambda path: [])
    resp = client.post("/agents/Jack/focus")
    assert resp.status_code == 200
    body = resp.json()
    assert body["focused"] is False
    assert body["ttys_found"] == 0


# ── agents: ttys ─────────────────────────────────────────────────────────────────

def test_get_agent_ttys(client, app_module, monkeypatch):
    register(client, name="Kim", path="/tmp/kim")
    monkeypatch.setattr(app_module, "_find_all_claude_ttys", lambda path: ["ttys005"])
    resp = client.get("/agents/Kim/ttys")
    assert resp.status_code == 200
    assert resp.json() == {"ttys": ["ttys005"]}


def test_get_agent_ttys_missing_agent_404(client):
    resp = client.get("/agents/Ghost/ttys")
    assert resp.status_code == 404


# ── agents: open terminal ────────────────────────────────────────────────────────

def test_open_terminal_missing_agent_404(client):
    resp = client.post("/agents/Ghost/terminal", json={})
    assert resp.status_code == 404


def test_open_terminal_success(client, app_module):
    register(client, name="Leo", path="/tmp/leo")
    resp = client.post("/agents/Leo/terminal", json={"model": "Default"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "model": "Default"}
    # subprocess.run was invoked (mocked) rather than a real osascript process
    assert len(app_module._subprocess_calls) >= 1
    call_args = app_module._subprocess_calls[-1][0][0]
    assert call_args[0] == "osascript"


def test_open_terminal_bare_shell(client, app_module):
    register(client, name="Mona", path="/tmp/mona")
    resp = client.post("/agents/Mona/terminal", json={"bare": True})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


def test_open_terminal_osascript_failure_returns_500(client, app_module, monkeypatch):
    register(client, name="Nora", path="/tmp/nora")

    def fake_run(*args, **kwargs):
        class _R:
            returncode = 1
            stdout = ""
            stderr = "boom"
        return _R()

    monkeypatch.setattr(app_module.subprocess, "run", fake_run)
    resp = client.post("/agents/Nora/terminal", json={})
    assert resp.status_code == 500


# ── agents: vortexia messaging (inject / register / poll) ─────────────────────
#
# Delivery is 100% vortexia now — no TTY, no on-disk pending queue. These
# tests stub out the actual MQTT calls (_vortexia_publish /
# _vortexia_set_presence_online / _vortexia_poll_inbox) so they run fully
# offline, same spirit as subprocess.run being mocked above. Real end-to-end
# delivery against a live vortexia broker is covered separately by
# tests/test_inject.py.

def test_inject_missing_agent_404(client):
    resp = client.post("/agents/Ghost/inject", json={"message": "hi"})
    assert resp.status_code == 404


def test_vortexia_register_and_poll_missing_agent_404(client):
    resp = client.post("/agents/Ghost/vortexia/register")
    assert resp.status_code == 404
    resp = client.get("/agents/Ghost/vortexia/poll")
    assert resp.status_code == 404


def test_inject_publishes_envelope_to_vortexia(client, app_module, monkeypatch):
    register(client, name="Opal", path="/tmp/opal")

    published = {}

    def fake_publish(topic, envelope, retain=False):
        published["topic"] = topic
        published["envelope"] = envelope
        published["retain"] = retain
        return True

    monkeypatch.setattr(app_module, "_vortexia_publish", fake_publish)

    resp = client.post(
        "/agents/Opal/inject",
        json={"message": "hello", "source": "agent", "from_agent": "Sender"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"ok": True, "injected": True, "queued": False, "via": "vortexia", "federated": False}

    assert published["topic"] == app_module.vx.inbox_topic("Opal")
    envelope = published["envelope"]
    assert envelope["from"] == "Sender"
    assert envelope["to"] == "Opal"
    assert envelope["source"] == "agent"
    assert envelope["text"] == "hello"
    assert "ts" in envelope
    assert published["retain"] is False, (
        "inject must NOT publish retained — the broker's per-agent mailbox "
        "(persistent session, vortexia PROTOCOL.md 'Mailboxes') queues every "
        "message for an offline recipient; a retained publish is the legacy "
        "single-slot behaviour where the latest message overwrote the rest"
    )


def test_inject_reports_failure_when_vortexia_unreachable(client, app_module, monkeypatch):
    register(client, name="Nomi", path="/tmp/nomi")
    monkeypatch.setattr(app_module, "_vortexia_publish", lambda topic, envelope, retain=False: False)

    resp = client.post("/agents/Nomi/inject", json={"message": "hi"})
    assert resp.status_code == 200
    assert resp.json()["injected"] is False


def test_vortexia_register_sets_presence(client, app_module, monkeypatch):
    register(client, name="Rex2", path="/tmp/rex2")
    calls = []
    monkeypatch.setattr(app_module, "_vortexia_set_presence_online", lambda name: calls.append(name) or True)

    resp = client.post("/agents/Rex2/vortexia/register")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "registered": True, "via": "vortexia"}
    assert calls == ["Rex2"]


def test_vortexia_poll_returns_pending_messages(client, app_module, monkeypatch):
    register(client, name="Opal2", path="/tmp/opal2")
    fake_messages = [{"from": "Bob", "to": "Opal2", "source": "agent", "text": "hi", "ts": 1}]
    monkeypatch.setattr(app_module, "_vortexia_poll_inbox", lambda name, timeout=2.0: fake_messages)

    resp = client.get("/agents/Opal2/vortexia/poll")
    assert resp.status_code == 200
    assert resp.json() == {"count": 1, "messages": fake_messages}


def test_vortexia_poll_names_a_relayed_sender_with_its_env(client, app_module, monkeypatch):
    register(client, name="System", path="/tmp/system")
    relayed = {"from": "System", "to": "System", "text": "hi", "kind": "vortex-relay-delivery", "routedFrom": "uy-mac", "ts": 1}
    monkeypatch.setattr(app_module, "_vortexia_poll_inbox", lambda name, timeout=2.0: [relayed])

    assert client.get("/agents/System/vortexia/poll").json()["messages"][0]["from"] == "System@uy-mac"


# ── agents: mute ─────────────────────────────────────────────────────────────────

def test_mute_unmute_and_status(client):
    resp = client.get("/agents/Pat/muted")
    assert resp.status_code == 200
    assert resp.json() == {"muted": False, "name": "Pat"}

    mute_resp = client.post("/agents/Pat/mute")
    assert mute_resp.status_code == 200
    assert mute_resp.json() == {"ok": True, "muted": True, "name": "Pat"}

    status = client.get("/agents/Pat/muted").json()
    assert status == {"muted": True, "name": "Pat"}

    unmute_resp = client.delete("/agents/Pat/mute")
    assert unmute_resp.status_code == 200
    assert unmute_resp.json() == {"ok": True, "muted": False, "name": "Pat"}

    status2 = client.get("/agents/Pat/muted").json()
    assert status2 == {"muted": False, "name": "Pat"}


def test_mute_is_idempotent(client):
    client.post("/agents/Quinn/mute")
    resp = client.post("/agents/Quinn/mute")
    assert resp.status_code == 200
    status = client.get("/agents/Quinn/muted").json()
    assert status["muted"] is True


# ── voices ───────────────────────────────────────────────────────────────────────

def test_list_voices(client):
    resp = client.get("/voices")
    assert resp.status_code == 200
    body = resp.json()
    assert "voices" in body
    names = {v["name"] for v in body["voices"]}
    assert "Samantha" in names
    assert "Paulina" in names


def test_random_voice(client):
    resp = client.get("/voices/random")
    assert resp.status_code == 200
    assert "voice" in resp.json()


def test_random_voice_avoids_taken_voices(client):
    # Register agents against every voice except one, so /voices/random must
    # return that single remaining one.
    import backend.main as main
    all_names = [v["name"] for v in main.NICE_VOICES]
    reserved, remaining = all_names[:-1], all_names[-1]
    for i, v in enumerate(reserved):
        client.post("/agents", json={"name": f"agent{i}", "voice": v, "path": "/tmp/x"})
    resp = client.get("/voices/random")
    assert resp.json()["voice"] == remaining


def test_get_voice_by_name(client):
    resp = client.get("/voices/Samantha")
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Samantha"
    assert body["lang"] == "en-US"


def test_get_voice_by_name_404(client):
    resp = client.get("/voices/NotARealVoice")
    assert resp.status_code == 404


# ── widget ───────────────────────────────────────────────────────────────────────

def test_widget_returns_html_with_agent_name(client):
    resp = client.get("/widget/Samantha")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    assert "Samantha" in resp.text
    assert "<title>Samantha</title>" in resp.text
    assert '<div class="name">Samantha</div>' in resp.text


# ── attribution ──────────────────────────────────────────────────────────────────

def test_attribution_post_and_get(client):
    entry = {
        "file": "foo.py",
        "agent": "AgentX",
        "name": "AgentX",
        "timestamp": "2026-01-01T00:00:00",
        "project": "local-agent-society",
    }
    resp = client.post("/attribution", json=entry)
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    all_entries = client.get("/attribution").json()
    assert len(all_entries) == 1
    assert all_entries[0]["file"] == "foo.py"

    by_file = client.get("/attribution", params={"file": "foo.py"}).json()
    assert len(by_file) == 1

    by_missing_file = client.get("/attribution", params={"file": "bar.py"}).json()
    assert by_missing_file == []

    by_name = client.get("/attribution", params={"name": "AgentX"}).json()
    assert len(by_name) == 1


# ── queue ────────────────────────────────────────────────────────────────────────

def test_queue_get_and_delete(client):
    client.post("/queue/speak", json={"text": "hi", "voice": "Samantha", "name": "Agent"})
    q = client.get("/queue").json()
    assert len(q) == 1

    del_resp = client.delete("/queue")
    assert del_resp.status_code == 200
    assert del_resp.json() == {"ok": True}

    q_after = client.get("/queue").json()
    assert q_after == []


# ── ports ────────────────────────────────────────────────────────────────────────

def test_ports_register_list_delete(client):
    resp = client.post(
        "/ports", json={"port": 9500, "app": "myapp", "local_agent": "Alice", "path": "/tmp/alice"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "port": 9500}

    ports = client.get("/ports").json()
    assert "9500" in ports
    assert ports["9500"]["app"] == "myapp"

    del_resp = client.delete("/ports/9500")
    assert del_resp.status_code == 200
    assert del_resp.json() == {"ok": True}

    ports_after = client.get("/ports").json()
    assert "9500" not in ports_after


def test_ports_delete_missing_404(client):
    resp = client.delete("/ports/9999")
    assert resp.status_code == 404


# ── pin-tty / pending-link (drag-to-link) ────────────────────────────────────────

def test_pin_tty_and_pending_link_roundtrip(client):
    resp = client.post("/agents/Rex/pin-tty", json={"tty": "/dev/ttys010"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "tty": "/dev/ttys010"}

    get_resp = client.get("/agents/Rex/pending-link")
    assert get_resp.status_code == 200
    assert get_resp.json() == {"tty": "/dev/ttys010"}

    # Consumed once — second read returns 204 with no body.
    second = client.get("/agents/Rex/pending-link")
    assert second.status_code == 204


def test_pin_tty_empty_value_not_ok(client):
    resp = client.post("/agents/Sam/pin-tty", json={"tty": ""})
    assert resp.status_code == 200
    assert resp.json() == {"ok": False, "tty": ""}


def test_pending_link_none_when_never_pinned(client):
    resp = client.get("/agents/NeverPinned/pending-link")
    assert resp.status_code == 204


def test_relayed_send_fails_when_the_gateway_rejects_the_name(client, app_module, monkeypatch):
    monkeypatch.setenv("VORTEXIA_ENV_NAME", "ba-mac")
    monkeypatch.setattr(app_module, "_relay_direct_send", lambda env, e: (True, f'no agent named "{e["to"]}" is known across vortex-relay'))
    resp = client.post("/agents/send", json={"to": "Ghost@uy-mac", "message": "hi", "from_agent": "Bob"})
    assert resp.status_code == 404
    assert "Ghost@uy-mac" in resp.json()["detail"] and "no agent named" in resp.json()["detail"]

    monkeypatch.setattr(app_module, "_relay_direct_send", lambda env, e: (True, None))
    resp = client.post("/agents/send", json={"to": "Ghost@uy-mac", "message": "hi", "from_agent": "Bob"})
    assert resp.json() == {"ok": True, "injected": True, "mode": "direct", "relayed": True}


def test_a_long_message_is_accepted(client, app_module, monkeypatch):
    # A 11.5K handoff bounced with 422 string_too_long when the cap was 10000 (2026-10-26).
    monkeypatch.setenv("VORTEXIA_ENV_NAME", "ba-mac")
    monkeypatch.setattr(app_module, "_relay_direct_send", lambda env, e: (True, None))
    resp = client.post("/agents/send", json={"to": "Ghost@uy-mac", "message": "x" * 50_000, "from_agent": "Bob"})
    assert resp.status_code == 200
