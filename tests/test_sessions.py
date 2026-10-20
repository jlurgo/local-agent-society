"""Connected sessions (docs/adr/0004 phase 2): an agent may have a Claude, a
Codex and a shell attached at once. The backend keeps the list, elects the
default (last used), publishes it retained for the bridges, prunes dead
processes, and routes `send` to the default / one session / all of them."""
import json
import os
import sys
import threading as _threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


class _NoStartThread(_threading.Thread):
    def start(self):
        pass


@pytest.fixture
def app(tmp_path, monkeypatch):
    sys.path.insert(0, str(Path(__file__).parent.parent))
    if "backend.main" in sys.modules:
        del sys.modules["backend.main"]
    monkeypatch.setattr(_threading, "Thread", _NoStartThread)
    import backend.main as main
    monkeypatch.undo()
    monkeypatch.setattr(main, "REGISTRY_FILE", tmp_path / "registry.json")
    monkeypatch.setattr(main, "SESSIONS_FILE", tmp_path / "sessions.json")
    monkeypatch.setattr(main, "PORTS_FILE", tmp_path / "ports.json")
    published = []
    monkeypatch.setattr(main, "_vortexia_publish", lambda topic, envelope, retain=False: (published.append((topic, envelope, retain)), True)[1])
    monkeypatch.setattr(main, "_pid_alive", lambda pid: int(pid) != 999)
    main.published = published
    client = TestClient(main.app)
    client.post("/agents", json={"name": "Robo", "voice": "Samantha", "path": str(tmp_path)})
    return main, client


def _register(client, sid, runtime, pid=1):
    r = client.post("/agents/Robo/sessions", json={"sid": sid, "runtime": runtime, "pid": pid, "cwd": "/x"})
    assert r.status_code == 200, r.text
    return r.json()


def _default_publishes(main):
    return [(t, e) for t, e, retain in main.published if t == "las/agent/Robo/default-session" and retain]


def test_register_makes_the_new_session_the_default_and_publishes_it_retained(app):
    main, client = app
    view = _register(client, "claude-1", "claude")
    assert view["default"] == "claude-1"
    assert _default_publishes(main)[-1][1]["sid"] == "claude-1"
    view = _register(client, "shell-1", "shell")
    assert view["default"] == "shell-1", "the session you just opened is the one you're using"
    assert [s["sid"] for s in view["sessions"]] == ["shell-1", "claude-1"]
    assert _default_publishes(main)[-1][1] ["runtime"] == "shell"


def test_touch_moves_the_default_and_delete_hands_it_to_the_next_most_recent(app):
    main, client = app
    _register(client, "claude-1", "claude")
    _register(client, "shell-1", "shell")
    assert client.post("/agents/Robo/sessions/claude-1/touch").json()["default"] == "claude-1"
    assert _default_publishes(main)[-1][1]["sid"] == "claude-1"
    assert client.post("/agents/Robo/sessions/nope/touch").status_code == 404
    gone = client.delete("/agents/Robo/sessions/claude-1").json()
    assert gone["removed"] is True and gone["default"] == "shell-1"
    empty = client.delete("/agents/Robo/sessions/shell-1").json()
    assert empty["default"] is None and empty["sessions"] == []
    assert _default_publishes(main)[-1][1] == {"sid": None, "runtime": None, "ts": _default_publishes(main)[-1][1]["ts"]}, "no default -> nobody holds the agent mailbox, it queues"


def test_dead_processes_are_pruned_on_read(app):
    main, client = app
    _register(client, "claude-1", "claude", pid=1)
    _register(client, "zombie", "shell", pid=999)
    view = client.get("/agents/Robo/sessions").json()
    assert [s["sid"] for s in view["sessions"]] == ["claude-1"]
    assert view["default"] == "claude-1"


def test_send_routes_to_default_one_session_by_id_or_runtime_or_all(app):
    main, client = app
    _register(client, "claude-1", "claude")
    _register(client, "codex-1", "codex")
    _register(client, "shell-1", "shell")

    r = client.post("/agents/send", json={"message": "hi", "to": "Robo", "from_agent": "Vortexia"}).json()
    assert r["mode"] == "direct"
    assert main.published[-1][0] == "las/agent/Robo/inbox", "plain send = the agent inbox, held by the default session"

    r = client.post("/agents/send", json={"message": "ls", "to": "Robo", "session": "shell-1", "from_agent": "Vortexia"}).json()
    assert r["mode"] == "session"
    assert main.published[-1][0] == "las/agent/Robo/sessions/shell-1/inbox"
    assert main.published[-1][1]["session"] == "shell-1"

    r = client.post("/agents/send", json={"message": "fix", "to": "Robo", "session": "claude"}).json()
    assert r["mode"] == "session"
    assert main.published[-1][0] == "las/agent/Robo/sessions/claude-1/inbox", "a runtime name picks its most recent session"

    before = len(main.published)
    r = client.post("/agents/send", json={"message": "all hands", "to": "Robo", "all_sessions": True}).json()
    assert r["mode"] == "all-sessions" and r["injected"] is True
    topics = sorted(t for t, e, _ in main.published[before:])
    assert topics == sorted(f"las/agent/Robo/sessions/{sid}/inbox" for sid in ("claude-1", "codex-1", "shell-1"))

    assert client.post("/agents/send", json={"message": "x", "to": "Robo", "session": "nope"}).status_code == 404
    client.delete("/agents/Robo/sessions/claude-1"); client.delete("/agents/Robo/sessions/codex-1"); client.delete("/agents/Robo/sessions/shell-1")
    assert client.post("/agents/send", json={"message": "x", "to": "Robo", "all_sessions": True}).status_code == 404, "never publish into a session mailbox nobody will hold"


# ── docs/adr/0005: the agent's own choice of child (sessions.target), the cc, the descriptors ──

def _write_config(tmp_path, **sessions):
    (tmp_path / ".las-agent.json").write_text(json.dumps({"name": "Robo", "voice": "Samantha", "sessions": sessions}))


def _send(client, **extra):
    r = client.post("/agents/send", json={"message": "make test", "to": "Robo", "from_agent": "Me", **extra})
    assert r.status_code == 200, r.text
    return r.json()


def _inbox_publishes(main):
    return [e for t, e, _ in main.published if t == "las/agent/Robo/inbox"]


def _session_publishes(main):
    return [(t.split("/")[4], e) for t, e, _ in main.published if t.startswith("las/agent/Robo/sessions/")]


def test_config_view_fills_sessions_defaults_and_patch_writes_the_file(app, tmp_path):
    main, client = app
    assert client.get("/agents/Nobody/config").status_code == 404
    view = client.get("/agents/Robo/config").json()
    assert view["file"] is None and view["config"] == {} and view["sessions"]["target"] == "default"
    assert client.patch("/agents/Robo/config", json={"sessions": {"target": "all"}}).status_code == 404, "no file to patch yet"
    _write_config(tmp_path, target="default")
    view = client.patch("/agents/Robo/config", json={"sessions": {"target": "shell", "cc_default": True}}).json()
    assert view["sessions"]["target"] == "shell" and view["sessions"]["cc_default"] is True
    on_disk = json.loads((tmp_path / ".las-agent.json").read_text())
    assert on_disk["sessions"] == {"target": "shell", "cc_default": True} and on_disk["voice"] == "Samantha"
    assert client.patch("/agents/Robo/config", json={"sessions": {"target": ""}}).status_code == 422
    assert client.patch("/agents/Robo/config", json={"name": "Other"}).status_code == 422


def test_sessions_view_carries_each_runtimes_descriptor_and_the_agents_target(app, tmp_path):
    main, client = app
    _write_config(tmp_path, target="all", cc_default=True, runtimes={"shell": {"scope": "deploys only"}})
    view = _register(client, "shell-1", "shell")
    assert view["target"] == "all" and view["cc_default"] is True
    shell = view["sessions"][0]
    assert shell["intelligent"] is False and shell["accepts"] == ["command"] and shell["scope"] == "deploys only"
    view = _register(client, "claude-1", "claude")
    assert next(s for s in view["sessions"] if s["sid"] == "claude-1")["intelligent"] is True


def test_a_plain_send_honors_the_agents_configured_target(app, tmp_path):
    main, client = app
    _register(client, "claude-1", "claude")
    _register(client, "shell-1", "shell")
    _write_config(tmp_path, target="claude")
    result = _send(client)
    assert result["mode"] == "session" and result["targets"] == ["claude-1"] and result["fallback_from"] is None
    assert _session_publishes(main)[-1][0] == "claude-1"
    _write_config(tmp_path, target="all")
    result = _send(client)
    assert result["mode"] == "all-sessions" and sorted(result["targets"]) == ["claude-1", "shell-1"]
    _write_config(tmp_path, target="default")
    result = _send(client)
    assert result["mode"] == "direct" and result["targets"] == []
    assert _inbox_publishes(main)[-1]["text"] == "make test"


def test_an_explicit_session_choice_beats_the_configured_target_and_a_missing_explicit_choice_is_404(app, tmp_path):
    main, client = app
    _register(client, "claude-1", "claude")
    _write_config(tmp_path, target="all")
    assert _send(client, session="claude")["targets"] == ["claude-1"]
    assert client.post("/agents/send", json={"message": "x", "to": "Robo", "session": "codex"}).status_code == 404
    client.delete("/agents/Robo/sessions/claude-1")
    assert client.post("/agents/send", json={"message": "x", "to": "Robo", "all_sessions": True}).status_code == 404


def test_a_configured_target_that_is_not_connected_falls_back_to_the_agent_mailbox_and_says_so(app, tmp_path):
    main, client = app
    _write_config(tmp_path, target="shell")
    result = _send(client)
    assert result["mode"] == "direct" and result["fallback_from"] == "shell" and result["injected"] is True
    assert _inbox_publishes(main)[-1]["text"] == "make test", "queued in the mailbox, never lost"
    _write_config(tmp_path, target="all")
    assert _send(client)["fallback_from"] == "all"


def test_cc_hands_the_default_session_a_for_the_record_copy_only_when_it_was_not_a_target(app, tmp_path):
    main, client = app
    _register(client, "shell-1", "shell")
    _register(client, "claude-1", "claude")  # last used -> the default, holds the agent mailbox
    result = _send(client, session="shell", cc=True)
    assert result["mode"] == "session" and result["cc"] is True
    copy = _inbox_publishes(main)[-1]
    assert copy["kind"] == "cc" and copy["text"] == "[cc → shell] make test" and copy["from"] == "Me"
    before = len(_inbox_publishes(main))
    assert _send(client, session="claude", cc=True)["cc"] is False, "the default itself was the target: nothing to copy"
    assert _send(client, all_sessions=True, cc=True)["cc"] is False, "all sessions already includes the default"
    assert len(_inbox_publishes(main)) == before
    _write_config(tmp_path, target="shell", cc_default=True)
    assert _send(client)["cc"] is True, "the agent's own cc_default applies to a plain send"
    _write_config(tmp_path, target="shell", cc_default=False)
    assert _send(client)["cc"] is False


def test_patch_refuses_to_overwrite_a_broken_file(app, tmp_path):
    main, client = app
    (tmp_path / ".las-agent.json").write_text('{"name": "Robo", "voice": "Samantha",}')
    r = client.patch("/agents/Robo/config", json={"sessions": {"target": "shell"}})
    assert r.status_code == 409 and "fix it by hand" in r.json()["detail"]
    assert (tmp_path / ".las-agent.json").read_text() == '{"name": "Robo", "voice": "Samantha",}', "untouched"


def test_a_shell_child_is_handed_everything_as_a_command_and_an_explicit_kind_passes_through(app, tmp_path):
    main, client = app
    _register(client, "shell-1", "shell")
    _register(client, "claude-1", "claude")
    _send(client, session="shell")
    assert _session_publishes(main)[-1][1]["kind"] == "command", "a child that accepts nothing but commands gets a command"
    _send(client, session="claude")
    assert "kind" not in _session_publishes(main)[-1][1], "prose stays prose for an intelligent child"
    _send(client, session="claude", kind="command")
    assert _session_publishes(main)[-1][1]["kind"] == "command"
    _send(client, kind="command")
    assert _inbox_publishes(main)[-1]["kind"] == "command", "the agent mailbox carries the sender's kind too"
    _write_config(tmp_path, target="all")
    _send(client)
    kinds = {sid: e.get("kind") for sid, e in _session_publishes(main)[-2:]}
    assert kinds == {"shell-1": "command", "claude-1": None}


def test_a_broken_config_file_never_takes_a_send_or_a_session_register_down(app, tmp_path):
    main, client = app
    (tmp_path / ".las-agent.json").write_text('{"sessions": "shell"}')
    assert _register(client, "claude-1", "claude")["target"] == "default"
    assert _send(client)["mode"] == "direct"


# ── session titles: what each child is working on (widget children list) ──

def test_title_is_set_per_session_without_moving_the_default_and_survives_a_re_register(app):
    main, client = app
    _register(client, "claude-1", "claude")
    _register(client, "codex-1", "codex")
    view = client.put("/agents/Robo/sessions/claude-1/title", json={"title": "  Widget   session titles "}).json()
    rows = {s["sid"]: s for s in view["sessions"]}
    assert rows["claude-1"]["title"] == "Widget session titles", "whitespace collapsed, never truncated"
    assert rows["codex-1"]["title"] == ""
    assert view["default"] == "codex-1", "naming a session is not using it"
    _register(client, "claude-1", "claude")
    assert {s["sid"]: s for s in client.get("/agents/Robo/sessions").json()["sessions"]}["claude-1"]["title"] == "Widget session titles"
    assert client.put("/agents/Robo/sessions/nope/title", json={"title": "x"}).status_code == 404


def test_title_request_goes_to_each_intelligent_session_mailbox_never_the_shell(app):
    main, client = app
    _register(client, "claude-1", "claude")
    _register(client, "codex-1", "codex")
    _register(client, "shell-1", "shell")
    main.published.clear()
    r = client.post("/agents/Robo/sessions/titles/request").json()
    assert sorted(r["asked"]) == ["claude-1", "codex-1"] and r["skipped"] == ["shell-1"]
    sent = {t.split("/")[4]: e for t, e, _ in main.published}
    assert set(sent) == {"claude-1", "codex-1"}, "only session mailboxes — never the agent inbox"
    for sid, env in sent.items():
        assert env["kind"] == "title-request" and env["session"] == sid
        assert f"--session {sid}" in env["text"] and "--name Robo" in env["text"], "the text stands alone: Codex gets it typed in"
    assert client.post("/agents/Nobody/sessions/titles/request").status_code == 404


# ── knowing where to send: the recipient's sessions in the send answer, the society map ──

def test_plain_send_goes_to_the_recipients_choice_and_tells_the_sender_what_else_is_open(app):
    main, client = app
    _register(client, "claude-1", "claude")
    _register(client, "shell-1", "shell")
    client.put("/agents/Robo/sessions/claude-1/title", json={"title": "Payments fix"})
    r = client.post("/agents/send", json={"message": "hi", "to": "Robo"}).json()
    assert r["mode"] == "direct", "no session named: the recipient's own default"
    rows = {s["sid"]: s for s in r["sessions"]}
    assert rows["claude-1"]["title"] == "Payments fix" and rows["shell-1"]["intelligent"] is False
    assert rows["shell-1"]["default"] is True


def test_society_map_lists_every_agent_with_live_sessions(app):
    main, client = app
    client.post("/agents", json={"name": "Other", "voice": "Daniel", "path": "/tmp/other"})
    _register(client, "claude-1", "claude")
    client.post("/agents/Other/sessions", json={"sid": "codex-9", "runtime": "codex", "pid": 1, "cwd": "/y"})
    client.post("/agents/Other/sessions", json={"sid": "dead-1", "runtime": "codex", "pid": 999, "cwd": "/y"})
    view = client.get("/sessions").json()["agents"]
    assert set(view) == {"Robo", "Other"}
    assert [s["sid"] for s in view["Other"]["sessions"]] == ["codex-9"], "dead processes pruned"
    assert view["Robo"]["target"] == "default"


def test_a_gone_session_has_its_broker_mailbox_dropped(app):
    main, client = app
    _register(client, "claude-1", "claude")
    _register(client, "codex-1", "codex", pid=999)   # dead process: pruned on the next read
    main.published.clear()
    client.get("/agents/Robo/sessions")
    client.delete("/agents/Robo/sessions/claude-1")
    drops = [e for t, e, _ in main.published if t == "vortexia/control/mailbox/drop"]
    assert {(d["clientId"], d["force"]) for d in drops} == {("las-agent-Robo-codex-1", False), ("las-agent-Robo-claude-1", True)}
    assert all(d["id"] for d in drops)


@pytest.fixture
def tty_calls(app, monkeypatch):
    """The tty side of beacon/close, recorded instead of touching a real terminal."""
    main, _ = app
    calls = []
    monkeypatch.setattr(main, "tty_of_pid", lambda pid: None if int(pid) == 2 else f"/dev/ttys{int(pid):03d}")
    monkeypatch.setattr(main, "set_terminal_title", lambda text, tty=None: (calls.append(("title", tty, text)), True)[1])
    monkeypatch.setattr(main, "ring_bell", lambda tty: (calls.append(("bell", tty)), True)[1])
    monkeypatch.setattr(main, "hangup_tty", lambda tty: (calls.append(("hangup", tty)), True)[1])
    monkeypatch.setattr(main, "SESSION_BEACON_SECONDS", 0.01)
    return calls


def test_beacon_titles_the_sessions_tty_uniquely_rings_and_restores_its_own_title(app, tty_calls):
    """The widget's find button: the beacon is what it asks Ghostty to focus, so it must be unique."""
    main, client = app
    _register(client, "claude-1", "claude", pid=5)
    client.put("/agents/Robo/sessions/claude-1/title", json={"title": "Fix the mic"})
    first = client.post("/agents/Robo/sessions/claude-1/beacon").json()
    second = client.post("/agents/Robo/sessions/claude-1/beacon").json()
    assert first["tty"] == "/dev/ttys005" and first["beacon"] != second["beacon"]
    assert ("title", "/dev/ttys005", first["beacon"]) in tty_calls and ("bell", "/dev/ttys005") in tty_calls
    import time
    time.sleep(0.1)
    assert ("title", "/dev/ttys005", "Robo · claude — Fix the mic") in tty_calls, "the session's own title comes back"


def test_close_hangs_up_the_sessions_tty_and_drops_it(app, tty_calls):
    main, client = app
    _register(client, "claude-1", "claude", pid=5)
    _register(client, "shell-1", "shell", pid=6)
    view = client.post("/agents/Robo/sessions/shell-1/close").json()
    assert ("hangup", "/dev/ttys006") in tty_calls and view["tty"] == "/dev/ttys006"
    assert [s["sid"] for s in view["sessions"]] == ["claude-1"] and view["default"] == "claude-1"
    assert any(t == "vortexia/control/mailbox/drop" for t, _, _ in main.published), "its mailbox goes with it"


def test_beacon_and_close_refuse_unknown_sessions_and_sessions_without_a_terminal(app, tty_calls):
    _, client = app
    _register(client, "headless", "codex", pid=2)
    assert client.post("/agents/Robo/sessions/nope/beacon").status_code == 404
    assert client.post("/agents/Robo/sessions/nope/close").status_code == 404
    assert client.post("/agents/Robo/sessions/headless/close").status_code == 409
    assert not any(c[0] == "hangup" for c in tty_calls), "never hang up a tty that could not be resolved"


def test_close_keeps_the_session_when_the_hangup_fails(app, tty_calls, monkeypatch):
    main, client = app
    _register(client, "shell-1", "shell", pid=6)
    monkeypatch.setattr(main, "hangup_tty", lambda tty: False)
    assert client.post("/agents/Robo/sessions/shell-1/close").status_code == 409
    assert [s["sid"] for s in client.get("/agents/Robo/sessions").json()["sessions"]] == ["shell-1"]
