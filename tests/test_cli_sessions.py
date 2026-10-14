"""`las agent sessions` and `send --session/--all-sessions` (docs/adr/0004 phase 2)."""
from click.testing import CliRunner

from cli.commands import agents as agents_mod
from cli.main import cli


def _spy(monkeypatch, view):
    gets, posts = [], []
    monkeypatch.setattr(agents_mod.api, "get", lambda path: (gets.append(path), view)[1])
    monkeypatch.setattr(agents_mod.api, "post", lambda path, data=None: (posts.append((path, data)), {"injected": True, "mode": "session" if data and data.get("session") else "all-sessions" if data and data.get("all_sessions") else "direct", **view})[1])
    return gets, posts


def test_sessions_lists_most_recent_first_with_the_default_marked(monkeypatch):
    view = {"agent": "Robo", "default": "shell-2", "sessions": [
        {"sid": "shell-2", "runtime": "shell", "pid": 2, "cwd": "/r", "lastActiveAt": 0, "default": True},
        {"sid": "claude-1", "runtime": "claude", "pid": 1, "cwd": "/r", "lastActiveAt": 0, "default": False},
    ]}
    _spy(monkeypatch, view)
    out = CliRunner().invoke(cli, ["agent", "sessions", "Robo"]).output.splitlines()
    assert out[0].startswith("* shell-2") and out[1].startswith("  claude-1")


def test_sessions_use_touches_by_id_or_runtime(monkeypatch):
    view = {"agent": "Robo", "default": "shell-2", "sessions": [
        {"sid": "shell-2", "runtime": "shell", "pid": 2, "cwd": "/r", "lastActiveAt": 0, "default": True},
        {"sid": "claude-1", "runtime": "claude", "pid": 1, "cwd": "/r", "lastActiveAt": 0, "default": False},
    ]}
    gets, posts = _spy(monkeypatch, view)
    assert CliRunner().invoke(cli, ["agent", "sessions", "Robo", "--use", "claude"]).exit_code == 0
    assert posts == [("/agents/Robo/sessions/claude-1/touch", {})]
    missing = CliRunner().invoke(cli, ["agent", "sessions", "Robo", "--use", "codex"])
    assert missing.exit_code == 1 and "no connected session" in missing.output


def test_send_session_and_all_sessions_flags_reach_the_backend(monkeypatch):
    gets, posts = _spy(monkeypatch, {})
    runner = CliRunner()
    assert runner.invoke(cli, ["agent", "send", "--to", "Robo", "--session", "shell", "ls", "--from", "Me"]).exit_code == 0
    assert runner.invoke(cli, ["agent", "send", "--to", "Robo", "--all-sessions", "hi", "--from", "Me"]).exit_code == 0
    assert posts[0] == ("/agents/send", {"message": "ls", "source": "agent", "from_agent": "Me", "to": "Robo", "session": "shell"})
    assert posts[1] == ("/agents/send", {"message": "hi", "source": "agent", "from_agent": "Me", "to": "Robo", "all_sessions": True})
    both = runner.invoke(cli, ["agent", "send", "--to", "Robo", "--session", "x", "--all-sessions", "hi"])
    assert both.exit_code != 0 and "exclusive" in both.output
    no_to = runner.invoke(cli, ["agent", "send", "--scope", "billing", "--session", "x", "hi"])
    assert no_to.exit_code != 0


def test_legacy_listen_stands_down_when_a_bridge_session_holds_the_mailbox(monkeypatch):
    """No fight with `las claude|codex|shell`: with a session registered, `listen` holds nothing and waits."""
    view = {"agent": "Robo", "default": "codex-1", "sessions": [{"sid": "codex-1", "runtime": "codex", "pid": 1, "cwd": "/r", "lastActiveAt": 0, "default": True}]}
    monkeypatch.setattr(agents_mod.api, "get", lambda path: view)
    slept = []

    def fake_sleep(s):
        slept.append(s)
        raise KeyboardInterrupt  # the Monitor/purge killing it, in test form

    monkeypatch.setattr(agents_mod.time, "sleep", fake_sleep)
    result = CliRunner().invoke(cli, ["agent", "listen", "Robo"])
    assert slept == [3600], "went to sleep instead of connecting as the mailbox consumer"
    assert "standing by without consuming anything" in result.output
    assert "las claude" in result.output

    monkeypatch.setattr(agents_mod.api, "get", lambda path: {"agent": "Robo", "default": None, "sessions": []} if path.endswith("/sessions") else {})
    agents_mod._legacy_listen_stand_down("Robo")  # no sessions: returns, the real consumer path would follow


def test_legacy_listen_yields_when_a_bridge_session_kicks_it_later(monkeypatch):
    """The bridge arrives AFTER listen: the first kick makes listen look, see the session, disconnect and stand by — never kick back."""
    import json as _json
    import sys as _sys
    import types as _types

    calls = {"sessions": 0}
    view_later = {"agent": "Robo", "default": "codex-1", "sessions": [{"sid": "codex-1", "runtime": "codex", "pid": 1, "cwd": "/r", "lastActiveAt": 0, "default": True}]}

    def fake_get(path):
        if path == "/ports":
            return {"9012": {"app": "vortexia-mqtt", "port": 9012, "registered_at": "2026-01-01T00:00:00"}}
        if path.endswith("/sessions"):
            calls["sessions"] += 1
            return {"agent": "Robo", "default": None, "sessions": []} if calls["sessions"] == 1 else view_later
        return {}

    monkeypatch.setattr(agents_mod.api, "get", fake_get)
    slept = []

    def fake_sleep(s):
        slept.append(s)
        raise KeyboardInterrupt

    monkeypatch.setattr(agents_mod.time, "sleep", fake_sleep)

    class FakeMQTTClient:
        instances = []

        def __init__(self, *a, **k):
            self.disconnected = False
            FakeMQTTClient.instances.append(self)

        def subscribe(self, *a, **k): pass
        def publish(self, *a, **k): pass
        def connect(self, *a, **k): pass
        def disconnect(self): self.disconnected = True

        def loop_forever(self):
            self.on_connect(self, None, {"session present": 0}, 0)
            self.on_disconnect(self, None, 7)  # kicked by the bridge taking the client id

    fake_client_mod = _types.SimpleNamespace(Client=FakeMQTTClient, MQTTv311="MQTTv311")
    pkg = _types.ModuleType("paho.mqtt"); pkg.client = fake_client_mod
    root = _types.ModuleType("paho"); root.mqtt = pkg
    monkeypatch.setitem(_sys.modules, "paho", root)
    monkeypatch.setitem(_sys.modules, "paho.mqtt", pkg)
    monkeypatch.setitem(_sys.modules, "paho.mqtt.client", fake_client_mod)

    result = CliRunner().invoke(agents_mod.listen, ["Robo"])
    assert slept == [3600], "blocked inside the disconnect callback — paho must never get to reconnect"
    assert "standing by" in result.output


# ── docs/adr/0005: `las agent target` and `send --cc` ──

def test_target_shows_the_agents_choice_and_the_connected_sessions(monkeypatch):
    view = {"agent": "Robo", "default": "claude-1", "target": "shell", "cc_default": True, "sessions": [
        {"sid": "claude-1", "runtime": "claude", "pid": 1, "cwd": "/r", "lastActiveAt": 0, "default": True, "intelligent": True},
        {"sid": "shell-2", "runtime": "shell", "pid": 2, "cwd": "/r", "lastActiveAt": 0, "default": False, "intelligent": False},
    ]}
    gets, _ = _spy(monkeypatch, view)
    patches = []
    monkeypatch.setattr(agents_mod.api, "patch", lambda path, data=None: (patches.append((path, data)), view)[1])
    out = CliRunner().invoke(cli, ["agent", "target", "--name", "Robo"]).output
    assert "messages go to session 'shell'" in out and "cc to the last-used session" in out
    assert "[not intelligent: commands only]" in out
    assert patches == [] and [g for g in gets if g != "/agents"] == ["/agents/Robo/sessions"]


def test_target_sets_target_and_cc_through_the_config_patch(monkeypatch):
    view = {"agent": "Robo", "default": None, "target": "codex", "cc_default": False, "sessions": []}
    _spy(monkeypatch, view)
    patches = []
    monkeypatch.setattr(agents_mod.api, "patch", lambda path, data=None: (patches.append((path, data)), view)[1])
    runner = CliRunner()
    out = runner.invoke(cli, ["agent", "target", "codex", "--name", "Robo"]).output
    assert patches == [("/agents/Robo/config", {"sessions": {"target": "codex"}})]
    assert "not connected — falls back to the last-used session" in out
    runner.invoke(cli, ["agent", "target", "--name", "Robo", "--no-cc"])
    assert patches[-1] == ("/agents/Robo/config", {"sessions": {"cc_default": False}})
    runner.invoke(cli, ["agent", "target", "all", "--cc", "--name", "Robo"])
    assert patches[-1] == ("/agents/Robo/config", {"sessions": {"target": "all", "cc_default": True}})


def test_send_cc_reaches_the_backend_and_needs_a_plain_to(monkeypatch):
    gets, posts = _spy(monkeypatch, {"cc": True})
    runner = CliRunner()
    result = runner.invoke(cli, ["agent", "send", "--to", "Robo", "--session", "shell", "--cc", "make test", "--from", "Me"])
    assert result.exit_code == 0, result.output
    assert posts[0] == ("/agents/send", {"message": "make test", "source": "agent", "from_agent": "Me", "to": "Robo", "session": "shell", "cc": True})
    assert "+ cc to the last-used session" in result.output
    assert runner.invoke(cli, ["agent", "send", "--to", "Robo", "--all-sessions", "--cc", "hi"]).exit_code != 0
    assert runner.invoke(cli, ["agent", "send", "--scope", "billing", "--cc", "hi"]).exit_code != 0


def test_send_reports_a_fallback_when_the_recipients_target_is_not_connected(monkeypatch):
    _spy(monkeypatch, {"fallback_from": "shell"})
    out = CliRunner().invoke(cli, ["agent", "send", "--to", "Robo", "hi", "--from", "Me"]).output
    assert "its target 'shell' is not connected" in out


def test_send_command_marks_the_kind(monkeypatch):
    _, posts = _spy(monkeypatch, {})
    assert CliRunner().invoke(cli, ["agent", "send", "--to", "Robo", "--session", "claude", "--command", "make test", "--from", "Me"]).exit_code == 0
    assert posts[0][1]["kind"] == "command" and posts[0][1]["session"] == "claude"


def test_send_to_another_machine_puts_the_session_in_the_address(monkeypatch):
    gets, posts = _spy(monkeypatch, {})
    runner = CliRunner()
    assert runner.invoke(cli, ["agent", "send", "--to", "Robo@uy-mac", "--session", "codex", "hi", "--from", "Me"]).exit_code == 0
    assert runner.invoke(cli, ["agent", "send", "--to", "Robo@uy-mac", "--all-sessions", "hi", "--from", "Me"]).exit_code == 0
    assert posts[0][1]["to"] == "Robo@uy-mac/codex" and "session" not in posts[0][1]
    assert posts[1][1]["to"] == "Robo@uy-mac/*" and "all_sessions" not in posts[1][1]


def test_plain_send_to_an_agent_with_several_sessions_lists_them(monkeypatch):
    view = {"sessions": [{"sid": "codex-1", "runtime": "codex", "title": "API review", "default": True},
                         {"sid": "shell-1", "runtime": "shell", "title": "", "intelligent": False}]}
    _spy(monkeypatch, view)
    out = CliRunner().invoke(cli, ["agent", "send", "--to", "Robo", "hi", "--from", "Me"]).output
    assert "Robo has 2 sessions" in out and '"API review"' in out and "[commands only]" in out
    picked = CliRunner().invoke(cli, ["agent", "send", "--to", "Robo", "--session", "codex", "hi", "--from", "Me"]).output
    assert "has 2 sessions" not in picked, "a sender that already picked is not lectured"


def test_exec_runs_a_script_without_shebang_through_sh_like_a_shell_would(monkeypatch, tmp_path):
    import errno
    from cli.commands import bridge as bridge_mod
    script = tmp_path / "claude"
    script.write_text("echo hi\n")
    calls = []

    def fake_execvp(prog, argv):
        raise OSError(errno.ENOEXEC, "Exec format error")

    monkeypatch.setattr(bridge_mod.os, "execvp", fake_execvp)
    class Replaced(Exception):
        pass

    def fake_execv(prog, argv):  # a real execv never returns
        calls.append((prog, argv))
        raise Replaced

    monkeypatch.setattr(bridge_mod.os, "execv", fake_execv)
    monkeypatch.setattr(bridge_mod.shutil, "which", lambda name: str(script))
    import pytest
    with pytest.raises(Replaced):
        bridge_mod._exec(["claude", "--flag"])
    assert calls == [("/bin/sh", ["/bin/sh", str(script), "--flag"])]

    binary = tmp_path / "bad"
    binary.write_bytes(b"\xcf\xfa\xed\xfe\0\0\0\0")
    monkeypatch.setattr(bridge_mod.shutil, "which", lambda name: str(binary))
    with pytest.raises(SystemExit):
        bridge_mod._exec(["claude"])


def test_claude_bin_prefers_the_native_install_over_path(monkeypatch, tmp_path):
    from cli.commands import bridge as bridge_mod
    native = tmp_path / "native-claude"
    native.write_text("#!/bin/sh\n"); native.chmod(0o755)
    monkeypatch.setattr(bridge_mod, "NATIVE_CLAUDE_PATHS", (str(tmp_path / "missing"), str(native)))
    assert bridge_mod.claude_bin() == str(native)
    monkeypatch.setattr(bridge_mod, "NATIVE_CLAUDE_PATHS", (str(tmp_path / "missing"),))
    assert bridge_mod.claude_bin() == "claude"
