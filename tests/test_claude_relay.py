"""A second Claude account on the same Mac (`las claudeRelay`, `las claude --account NAME`).

Claude Code keeps one login per CLAUDE_CONFIG_DIR. LAS follows that dir for
three things: where the `las` MCP server is registered (the dir's own
.claude.json), the runtime the session registers as (claudeRelay next to
claude), and — through the per-session status file — which bridge
`las bridge status` reports, so two Claude sessions of one agent coexist."""
import json
import os

import pytest
from click.testing import CliRunner

from cli.agent_config import runtime_descriptor
from cli.commands import bridge as bridge_mod
from cli.main import cli


@pytest.fixture(autouse=True)
def _isolated_home(monkeypatch, tmp_path):
    for var in ("CLAUDE_CONFIG_DIR", "LAS_CLAUDE_CONFIG", "LAS_CLAUDE_RUNTIME", "CLAUDECODE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(bridge_mod.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(bridge_mod, "_las", lambda: "/Users/me/.local/bin/las")
    return tmp_path


def test_default_account_is_plain_claude_at_home_claude_json(tmp_path):
    assert bridge_mod.claude_runtime() == "claude"
    assert bridge_mod.claude_config_path() == tmp_path / ".claude.json"
    assert bridge_mod.mcp_server_entry()["args"] == ["bridge", "claude"]


def test_claude_config_dir_drives_config_path_and_runtime(monkeypatch, tmp_path):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude-relay"))
    assert bridge_mod.claude_config_path() == tmp_path / ".claude-relay" / ".claude.json", "no LAS_CLAUDE_CONFIG needed"
    assert bridge_mod.claude_account() == "relay"
    assert bridge_mod.claude_runtime() == "claudeRelay"
    assert bridge_mod.mcp_server_entry()["args"] == ["bridge", "claude", "--runtime", "claudeRelay"]

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude-big-corp"))
    assert bridge_mod.claude_runtime() == "claudeBigCorp"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude"))
    assert bridge_mod.claude_runtime() == "claude", "pointing at the default dir is the default account"
    monkeypatch.setenv("LAS_CLAUDE_RUNTIME", "claudeWork")
    assert bridge_mod.claude_runtime() == "claudeWork", "explicit override wins"


def test_las_claude_config_still_overrides_the_path(monkeypatch, tmp_path):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude-relay"))
    monkeypatch.setenv("LAS_CLAUDE_CONFIG", str(tmp_path / "elsewhere.json"))
    assert bridge_mod.claude_config_path() == tmp_path / "elsewhere.json"


def test_bridge_claude_passes_the_runtime_from_the_inherited_config_dir(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(bridge_mod, "_exec", lambda argv: calls.append(argv))
    monkeypatch.setattr(bridge_mod, "_node", lambda: "/usr/local/bin/node")
    runner = CliRunner()
    runner.invoke(cli, ["bridge", "claude", "Robo"])
    runner.invoke(cli, ["bridge", "claude", "Robo"], env={"CLAUDE_CONFIG_DIR": str(tmp_path / ".claude-relay")})
    runner.invoke(cli, ["bridge", "claude", "Robo", "--runtime", "claudeX"])
    bin_path = str(bridge_mod.BRIDGE_BIN)
    assert calls[0] == ["/usr/local/bin/node", bin_path, "claude", "--agent", "Robo"]
    assert calls[1] == ["/usr/local/bin/node", bin_path, "claude", "--agent", "Robo", "--runtime", "claudeRelay"]
    assert calls[2][-2:] == ["--runtime", "claudeX"]


def _launch_spies(monkeypatch):
    calls, posts = [], []
    monkeypatch.setattr(bridge_mod, "_exec", lambda argv: calls.append((argv, os.environ.get("CLAUDE_CONFIG_DIR"))))
    monkeypatch.setattr(bridge_mod, "claude_bin", lambda: "claude")
    monkeypatch.setattr(bridge_mod, "_agent_name_from_cwd", lambda: "Robo")
    monkeypatch.setattr(bridge_mod.api, "post", lambda path, data=None: (posts.append(path), {"registered": True})[1])
    monkeypatch.setattr(bridge_mod.subprocess, "run", lambda argv, **kw: None)
    monkeypatch.setattr(bridge_mod.shutil, "which", lambda name: f"/usr/local/bin/{name}")
    return calls, posts


@pytest.mark.parametrize("argv", [["claudeRelay", "--resume"], ["claude", "--account", "relay", "--resume"]])
def test_las_claude_relay_sets_up_the_account_and_launches_claude_in_it(monkeypatch, tmp_path, argv):
    home_claude = tmp_path / ".claude"
    (home_claude / "skills").mkdir(parents=True)
    (home_claude / "CLAUDE.md").write_text("rules")
    (home_claude / "settings.json").write_text("{}")
    personal = tmp_path / ".claude.json"
    personal.write_text(json.dumps({"mcpServers": {}}))
    monkeypatch.setenv("LAS_CLAUDE_CONFIG", str(tmp_path / "stale.json"))
    calls, posts = _launch_spies(monkeypatch)
    try:
        result = CliRunner().invoke(cli, argv)
        assert result.exit_code == 0, result.output
        relay = tmp_path / ".claude-relay"
        assert calls == [(["claude", bridge_mod.CLAUDE_CHANNEL_FLAG, bridge_mod.CLAUDE_CHANNEL_SERVER, "--resume"], str(relay))], \
            "claude runs with the relay config dir, args passed through"
        assert json.loads((relay / ".claude.json").read_text())["mcpServers"]["las"]["args"] == ["bridge", "claude", "--runtime", "claudeRelay"]
        assert json.loads(personal.read_text()) == {"mcpServers": {}}, "the personal account's config is untouched"
        assert not (tmp_path / "stale.json").exists(), "a stale LAS_CLAUDE_CONFIG must not redirect the registration"
        assert (relay / "CLAUDE.md").is_symlink() and (relay / "CLAUDE.md").resolve() == (home_claude / "CLAUDE.md").resolve()
        assert (relay / "skills").is_symlink()
        assert not (relay / "hooks").exists(), "nothing to link when ~/.claude lacks it"
        assert posts == ["/agents/Robo/vortexia/register"]
    finally:
        # _use_account writes os.environ directly (claude is exec'd with it); don't leak into other tests.
        os.environ.pop("CLAUDE_CONFIG_DIR", None)


def test_account_dir_bootstrap_never_replaces_what_is_there(tmp_path):
    home_claude = tmp_path / ".claude"
    home_claude.mkdir()
    (home_claude / "CLAUDE.md").write_text("shared")
    (home_claude / "settings.json").write_text("{}")
    relay = tmp_path / ".claude-relay"
    relay.mkdir()
    (relay / "settings.json").write_text('{"own": true}')
    assert bridge_mod.ensure_account_dir(relay, home_claude) == ["CLAUDE.md"]
    assert (relay / "settings.json").read_text() == '{"own": true}'
    assert bridge_mod.ensure_account_dir(relay, home_claude) == [], "idempotent"


def test_a_personal_entry_in_the_relay_config_is_upgraded_to_name_its_runtime(monkeypatch, tmp_path):
    relay = tmp_path / ".claude-relay"
    relay.mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(relay))
    las = tmp_path / "las"
    las.write_text("#!/bin/sh\n")
    las.chmod(0o755)
    monkeypatch.setattr(bridge_mod, "_las", lambda: str(las))
    (relay / ".claude.json").write_text(json.dumps({"mcpServers": {"las": {"command": str(las), "args": ["bridge", "claude"]}}}))
    bridge_mod.ensure_mcp_registered()
    assert json.loads((relay / ".claude.json").read_text())["mcpServers"]["las"]["args"] == ["bridge", "claude", "--runtime", "claudeRelay"]


def test_status_reports_this_sessions_bridge_when_two_claude_sessions_are_open(monkeypatch, tmp_path):
    monkeypatch.setattr(bridge_mod, "SESSION_DIR", tmp_path)
    me = os.getpid()
    other = os.getppid()  # alive, but not "mine" for this test
    (tmp_path / "bridge-Robo@claude-1-aa.json").write_text(json.dumps({"agent": "Robo", "sink": "claude-channel", "pid": other, "runtime": "claude", "armed": False}))
    (tmp_path / "bridge-Robo@claudeRelay-2-bb.json").write_text(json.dumps({"agent": "Robo", "sink": "claude-channel", "pid": me, "runtime": "claudeRelay", "armed": True, "delivered": 2}))
    from cli import terminal
    monkeypatch.setattr(terminal, "ancestors", lambda pid=None: [(me, "claude")])
    monkeypatch.delenv("CLAUDECODE", raising=False)
    result = CliRunner().invoke(cli, ["bridge", "status", "Robo"])
    assert result.exit_code == 0, result.output
    assert "(claudeRelay)" in result.output and "2 delivered" in result.output

    monkeypatch.setattr(terminal, "ancestors", lambda pid=None: [])
    result = CliRunner().invoke(cli, ["bridge", "status", "Robo"])
    assert result.exit_code == 0, "from a plain terminal: an armed one answers"


def test_the_relay_guide_names_its_own_reconnect_command(monkeypatch, tmp_path):
    monkeypatch.setattr(bridge_mod, "SESSION_DIR", tmp_path)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude-relay"))
    result = CliRunner().invoke(cli, ["bridge", "status", "Robo"])
    assert "las claudeRelay --resume" in result.output
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude-work"))
    assert "las claude --account work --resume" in CliRunner().invoke(cli, ["bridge", "status", "Robo"]).output


def test_a_second_claude_account_is_described_as_claude():
    assert runtime_descriptor({}, "claudeRelay") == runtime_descriptor({}, "claude")
    assert runtime_descriptor({}, "claudeRelay")["intelligent"] is True


# ── an org that blocks channels: type into the prompt instead ────────────────

def _blocked_log(tmp_path, session_id, project="-Users-me-Development-Robo"):
    logs = tmp_path / "Library/Caches/claude-cli-nodejs" / project / "mcp-logs-las"
    logs.mkdir(parents=True, exist_ok=True)
    (logs / "2026-10-13T19-43-14-576Z.jsonl").write_text("\n".join([
        json.dumps({"debug": "Successfully connected (transport: stdio) in 594ms", "sessionId": session_id}),
        json.dumps({"debug": "Channel notifications skipped: channels not enabled by org policy (set channelsEnabled: true in managed settings)", "sessionId": session_id}),
    ]) + "\n")


def _relay_session(tmp_path, session_id):
    projects = tmp_path / ".claude-relay/projects/-Users-me-Development-Robo"
    projects.mkdir(parents=True, exist_ok=True)
    (projects / f"{session_id}.jsonl").write_text("{}\n")
    return tmp_path / ".claude-relay"


def test_channels_blocked_reads_claude_codes_own_verdict_for_this_accounts_sessions(tmp_path):
    relay = _relay_session(tmp_path, "relay-session")
    assert bridge_mod.channels_blocked(relay) is False, "no log yet: assume channels work"
    _blocked_log(tmp_path, "someone-elses-session")
    assert bridge_mod.channels_blocked(relay) is False, "another account's verdict is not this one's"
    _blocked_log(tmp_path, "relay-session", project="-Users-me-Development-Other")
    assert bridge_mod.channels_blocked(relay) is True
    assert bridge_mod.channels_blocked(None) is False, "the personal account is never second-guessed"


def _pty_spies(monkeypatch):
    calls, ptys = _launch_spies(monkeypatch)[0], []
    monkeypatch.setattr(bridge_mod, "_run_in_pty_with_bridge",
                        lambda name, argv, runtime, cwd, *a, resume_command=None: (
                            ptys.append((name, argv, runtime, os.environ.get("CLAUDE_CONFIG_DIR"))), resumes.append(resume_command), 0)[2])
    resumes = []
    _pty_spies.resumes = resumes
    return calls, ptys


def test_claude_relay_falls_back_to_the_pty_when_its_org_blocks_channels(monkeypatch, tmp_path):
    _relay_session(tmp_path, "relay-session")
    _blocked_log(tmp_path, "relay-session")
    calls, ptys = _pty_spies(monkeypatch)
    try:
        result = CliRunner().invoke(cli, ["claudeRelay", "--resume"])
        assert result.exit_code == 0, result.output
        assert calls == [], "no channel launch"
        assert ptys == [("Robo", ["claude", "--resume"], "claudeRelay", str(tmp_path / ".claude-relay"))], \
            "claude in a PTY, without the channel flag, fed by a claudeRelay session bridge"
        assert "blocks Claude Code channels" in result.output
        assert _pty_spies.resumes[-1] == "las claudeRelay", \
            "Claude's goodbye says bare `claude --resume` (personal account, no LAS): the PTY prints the claudeRelay one"

        ptys.clear()
        CliRunner().invoke(cli, ["claudeRelay", "--channel"])
        assert ptys == [] and calls[-1][0][1] == bridge_mod.CLAUDE_CHANNEL_FLAG, "--channel forces a retry of the channel"
    finally:
        os.environ.pop("CLAUDE_CONFIG_DIR", None)


def test_pty_can_be_asked_for_explicitly_on_any_account(monkeypatch, tmp_path):
    calls, ptys = _pty_spies(monkeypatch)
    result = CliRunner().invoke(cli, ["claude", "--pty", "--resume"])
    assert result.exit_code == 0, result.output
    assert ptys == [("Robo", ["claude", "--resume"], "claude", None)] and calls == []
    assert _pty_spies.resumes[-1] == "las claude"


def test_run_in_pty_with_bridge_wires_a_session_bridge_of_that_runtime(monkeypatch):
    popens, ptys = [], []

    class FakeProc:
        def __init__(self, argv, **kw):
            popens.append(argv)
            r, _w = os.pipe()
            self.stdout = os.fdopen(r, "rb")
        def terminate(self): pass
        def wait(self, timeout=None): return 0

    monkeypatch.setattr(bridge_mod.subprocess, "Popen", FakeProc)
    monkeypatch.setattr(bridge_mod, "_node", lambda: "/usr/local/bin/node")
    from cli import pty_session
    monkeypatch.setattr(pty_session, "run_in_pty", lambda argv, **kw: (ptys.append((argv, kw["cwd"])), 3)[1])
    assert bridge_mod._run_in_pty_with_bridge("Robo", ["claude"], "claudeRelay", "/r") == 3
    assert popens == [["/usr/local/bin/node", str(bridge_mod.BRIDGE_BIN), "stdout", "--agent", "Robo", "--runtime", "claudeRelay", "--quiet"]]
    assert ptys == [(["claude"], "/r")]
