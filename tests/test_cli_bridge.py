"""`las bridge` and `las claude` are thin launchers over bridge/bin/las-bridge.js
(docs/adr/0004): these tests pin the argv they hand to the Node bridge, the
research-preview channel flag `las claude` adds, the status file contract
the /las-agent skill relies on, and the idempotent ~/.claude.json edit."""
import json
import os

from click.testing import CliRunner

import pytest

from cli.commands import bridge as bridge_mod
from cli.main import cli


@pytest.fixture(autouse=True)
def _never_touch_the_real_claude_config(monkeypatch, tmp_path):
    """Every test here writes ~/.claude.json only through this override — a test
    once could have registered a fake node path into the real file."""
    monkeypatch.setenv("LAS_CLAUDE_CONFIG", str(tmp_path / "claude.json"))
    monkeypatch.setattr(bridge_mod, "_las", lambda: "/Users/me/.local/bin/las")
    # The suite itself often runs from inside a Claude session (CLAUDECODE set):
    # that must not turn every `las claude` under test into the reconnect guide.
    monkeypatch.delenv("CLAUDECODE", raising=False)
    # Nor may a run from inside the second account's session (claudeRelay) leak its config dir in.
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("LAS_CLAUDE_RUNTIME", raising=False)


def _capture(monkeypatch):
    calls = []
    monkeypatch.setattr(bridge_mod, "_exec", lambda argv: calls.append(argv))
    monkeypatch.setattr(bridge_mod, "_node", lambda: "/usr/local/bin/node")
    return calls


def test_each_sink_launches_the_node_bridge_with_agent_and_sink(monkeypatch):
    calls = _capture(monkeypatch)
    runner = CliRunner()
    assert runner.invoke(cli, ["bridge", "claude", "Robo"]).exit_code == 0
    assert runner.invoke(cli, ["bridge", "stdout", "Robo", "--port", "9012"]).exit_code == 0
    assert runner.invoke(cli, ["bridge", "shell", "Robo", "--yes", "--all"]).exit_code == 0
    assert runner.invoke(cli, ["bridge", "exec", "Robo", "--exec", "codex exec -", "--intercept-url", "http://localhost:9999/decide"]).exit_code == 0
    bin_path = str(bridge_mod.BRIDGE_BIN)
    assert calls[0] == ["/usr/local/bin/node", bin_path, "claude", "--agent", "Robo"]
    assert calls[1] == ["/usr/local/bin/node", bin_path, "stdout", "--agent", "Robo", "--port", "9012"]
    assert calls[2] == ["/usr/local/bin/node", bin_path, "shell", "--agent", "Robo", "--yes", "--all"]
    assert calls[3] == ["/usr/local/bin/node", bin_path, "exec", "--agent", "Robo", "--exec", "codex exec -", "--intercept-url", "http://localhost:9999/decide"]


def test_exec_sink_requires_a_command(monkeypatch):
    calls = _capture(monkeypatch)
    result = CliRunner().invoke(cli, ["bridge", "exec", "Robo"])
    assert result.exit_code != 0
    assert "--exec" in result.output
    assert calls == []


def test_las_claude_adds_the_channel_flag_and_passes_everything_else_through(monkeypatch):
    calls = _capture(monkeypatch)
    monkeypatch.setattr(bridge_mod.shutil, "which", lambda name: "/usr/local/bin/claude")
    result = CliRunner().invoke(cli, ["claude", "--resume", "--model", "opus"])
    assert result.exit_code == 0, result.output
    assert calls == [["claude", bridge_mod.CLAUDE_CHANNEL_FLAG, bridge_mod.CLAUDE_CHANNEL_SERVER, "--resume", "--model", "opus"]]
    assert bridge_mod.CLAUDE_CHANNEL_FLAG == "--dangerously-load-development-channels"
    assert bridge_mod.CLAUDE_CHANNEL_SERVER == "server:las"


def test_status_exit_code_is_the_skill_contract(monkeypatch, tmp_path):
    monkeypatch.setattr(bridge_mod, "SESSION_DIR", tmp_path)
    runner = CliRunner()
    absent = runner.invoke(cli, ["bridge", "status", "Robo"])
    assert absent.exit_code == 1
    assert "no bridge running" in absent.output
    assert "las claude --resume" in absent.output, "the way back in is printed, not just the problem"

    (tmp_path / "bridge-Robo.json").write_text(json.dumps({"agent": "Robo", "sink": "claude-channel", "pid": os.getpid(), "armed": False, "delivered": 0}))
    waiting = runner.invoke(cli, ["bridge", "status", "Robo"])
    assert waiting.exit_code == 1
    assert "waiting" in waiting.output

    (tmp_path / "bridge-Robo.json").write_text(json.dumps({"agent": "Robo", "sink": "claude-channel", "pid": os.getpid(), "armed": True, "delivered": 3}))
    armed = runner.invoke(cli, ["bridge", "status", "Robo"])
    assert armed.exit_code == 0
    assert "armed, 3 delivered" in armed.output

    (tmp_path / "bridge-Robo.json").write_text(json.dumps({"agent": "Robo", "sink": "claude-channel", "pid": 999999999, "armed": True}))
    dead = runner.invoke(cli, ["bridge", "status", "Robo"])
    assert dead.exit_code == 1, "a stale status file from a dead process must not read as delivering"


def test_claude_register_is_idempotent_and_unregister_removes_it(monkeypatch, tmp_path):
    config = tmp_path / ".claude.json"
    config.write_text(json.dumps({"theme": "dark", "mcpServers": {"other": {"command": "x"}}}))
    monkeypatch.setenv("LAS_CLAUDE_CONFIG", str(config))
    runner = CliRunner()

    first = runner.invoke(cli, ["claude", "register"])
    assert first.exit_code == 0, first.output
    data = json.loads(config.read_text())
    assert data["theme"] == "dark" and "other" in data["mcpServers"], "other keys untouched"
    assert data["mcpServers"]["las"] == {"command": "/Users/me/.local/bin/las", "args": ["bridge", "claude"]}, \
        "the stable `las` shim, never an absolute node path (that depends on the shell that ran it)"
    assert "registered" in first.output and "las claude" in first.output

    second = runner.invoke(cli, ["claude", "register"])
    assert "already registered" in second.output
    assert json.loads(config.read_text()) == data

    gone = runner.invoke(cli, ["claude", "unregister"])
    assert gone.exit_code == 0
    assert "las" not in json.loads(config.read_text())["mcpServers"]

    config.write_text("{not json")
    broken = runner.invoke(cli, ["claude", "register"])
    assert broken.exit_code == 1 and "not touching" in broken.output
    assert config.read_text() == "{not json"


def test_a_working_entry_is_never_rewritten_but_a_broken_one_is_repaired(monkeypatch, tmp_path):
    config = tmp_path / ".claude.json"
    monkeypatch.setenv("LAS_CLAUDE_CONFIG", str(config))
    good_node = tmp_path / "node"
    good_node.write_text("#!/bin/sh\n")
    good_node.chmod(0o755)
    older_shape = {"command": str(good_node), "args": [str(bridge_mod.BRIDGE_BIN), "claude"]}
    config.write_text(json.dumps({"mcpServers": {"las": older_shape}}))
    assert bridge_mod.ensure_mcp_registered() is True
    assert json.loads(config.read_text())["mcpServers"]["las"] == older_shape, "an older but working entry stays"
    assert "already registered" in CliRunner().invoke(cli, ["claude", "register"]).output

    broken = {"command": "/usr/local/bin/node-that-does-not-exist", "args": [str(bridge_mod.BRIDGE_BIN), "claude"]}
    config.write_text(json.dumps({"mcpServers": {"las": broken}}))
    assert bridge_mod.ensure_mcp_registered() is True
    assert json.loads(config.read_text())["mcpServers"]["las"] == {"command": "/Users/me/.local/bin/las", "args": ["bridge", "claude"]}, "a dead command is repaired"

    config.write_text(json.dumps({"mcpServers": {"las": older_shape}}))
    forced = CliRunner().invoke(cli, ["claude", "register", "--force"])
    assert "registered ->" in forced.output
    assert json.loads(config.read_text())["mcpServers"]["las"]["args"] == ["bridge", "claude"]


def test_node_is_found_on_path_or_in_nvm_and_homebrew_fallbacks(monkeypatch, tmp_path):
    monkeypatch.setattr(bridge_mod.shutil, "which", lambda name: "/path/node" if name == "node" else None)
    assert bridge_mod._node() == "/path/node"
    monkeypatch.setattr(bridge_mod.shutil, "which", lambda name: None)
    nvm = tmp_path / ".nvm/versions/node"
    for v in ("v18.18.2", "v20.20.2", "v20.20.1"):
        d = nvm / v / "bin"
        d.mkdir(parents=True)
        (d / "node").write_text("")
        (d / "node").chmod(0o755)
    monkeypatch.setattr(bridge_mod.Path, "home", classmethod(lambda cls: tmp_path))
    assert bridge_mod._node() == str(nvm / "v20.20.2/bin/node"), "newest nvm install wins"
    monkeypatch.setattr(bridge_mod, "_node_candidates", lambda: ["/nowhere/node"])
    result = CliRunner().invoke(cli, ["bridge", "stdout", "Robo"])
    assert result.exit_code == 1 and "node not found" in result.output


# ── one command per runtime, chaining everything the session needs ────────────

def _chain_spies(monkeypatch, tmp_path, agent="Robo"):
    calls = _capture(monkeypatch)
    monkeypatch.setattr(bridge_mod, "_agent_name_from_cwd", lambda: agent)
    monkeypatch.setattr(bridge_mod, "resolve_agent_name", lambda name, **kw: name or agent)
    config = tmp_path / ".claude.json"
    monkeypatch.setenv("LAS_CLAUDE_CONFIG", str(config))
    posts = []
    monkeypatch.setattr(bridge_mod.api, "post", lambda path, data=None: (posts.append(path), {"registered": True})[1])
    opened = []
    monkeypatch.setattr(bridge_mod.subprocess, "run", lambda argv, **kw: opened.append(argv))
    monkeypatch.setattr(bridge_mod.sys, "platform", "darwin")
    monkeypatch.setattr(bridge_mod.shutil, "which", lambda name: f"/usr/local/bin/{name}")
    return calls, config, posts, opened


def test_las_claude_chains_mcp_registration_presence_and_widget_then_execs(monkeypatch, tmp_path):
    calls, config, posts, opened = _chain_spies(monkeypatch, tmp_path)
    result = CliRunner().invoke(cli, ["claude", "--resume"])
    assert result.exit_code == 0, result.output
    assert json.loads(config.read_text())["mcpServers"]["las"] == {"command": "/Users/me/.local/bin/las", "args": ["bridge", "claude"]}, "MCP server registered without a separate install step"
    assert posts == ["/agents/Robo/vortexia/register"], "presence published"
    assert opened == [["open", "localagentsociety://Robo?action=reopen"]], "widget brought to this Space"
    assert calls == [["claude", bridge_mod.CLAUDE_CHANNEL_FLAG, bridge_mod.CLAUDE_CHANNEL_SERVER, "--resume"]]


def test_las_claude_outside_an_agent_folder_skips_the_chain_but_still_passes_the_flag(monkeypatch, tmp_path):
    calls, config, posts, opened = _chain_spies(monkeypatch, tmp_path, agent=None)
    assert CliRunner().invoke(cli, ["claude"]).exit_code == 0
    assert not config.exists() and posts == [] and opened == []
    assert calls == [["claude", bridge_mod.CLAUDE_CHANNEL_FLAG, bridge_mod.CLAUDE_CHANNEL_SERVER]]


def test_chain_fails_soft_when_the_backend_is_down(monkeypatch, tmp_path):
    calls, config, posts, opened = _chain_spies(monkeypatch, tmp_path)

    def down(path, data=None):
        print("Error: backend not running. Try `las start`.")
        raise SystemExit(1)

    monkeypatch.setattr(bridge_mod.api, "post", down)
    result = CliRunner().invoke(cli, ["claude", "--no-widget"])
    assert result.exit_code == 0, "a dead backend must not stop the session from opening"
    assert "presence not published" in result.output
    assert opened == [], "--no-widget honored"
    assert len(calls) == 1


def test_las_codex_opens_the_tui_in_a_pty_with_the_bridge_typing_into_it(monkeypatch, tmp_path):
    calls, config, posts, opened = _chain_spies(monkeypatch, tmp_path)
    runs = []
    monkeypatch.setattr(bridge_mod, "run_codex_interactive", lambda name, agent_dir, codex_args=(), intercept_url=None, port=None: (runs.append((name, tuple(codex_args), intercept_url)), 0)[1])
    monkeypatch.delenv("LAS_CODEX_CMD", raising=False)
    runner = CliRunner()
    assert runner.invoke(cli, ["codex"]).exit_code == 0
    assert runner.invoke(cli, ["codex", "--model", "gpt-6-astra", "--intercept-url", "http://x/decide"]).exit_code == 0
    assert runs == [("Robo", (), None), ("Robo", ("--model", "gpt-6-astra"), "http://x/decide")], "codex's own args pass through; ours don't"
    assert calls == [], "no headless exec sink was launched"
    assert posts == ["/agents/Robo/vortexia/register"] * 2 and len(opened) == 2, "the chain still runs"


def test_las_codex_exec_keeps_the_headless_path_and_las_shell_launches_its_sink(monkeypatch, tmp_path):
    calls, config, posts, opened = _chain_spies(monkeypatch, tmp_path)
    runner = CliRunner()
    assert runner.invoke(cli, ["codex", "--exec", bridge_mod.CODEX_DEFAULT_CMD]).exit_code == 0
    assert runner.invoke(cli, ["shell", "--yes"]).exit_code == 0
    monkeypatch.setenv("LAS_CODEX_CMD", "my-router --stdin")
    assert runner.invoke(cli, ["codex", "--no-widget"]).exit_code == 0
    bin_path = str(bridge_mod.BRIDGE_BIN)
    assert calls[0] == ["/usr/local/bin/node", bin_path, "exec", "--agent", "Robo", "--exec", "codex exec --yolo -"]
    assert calls[1] == ["/usr/local/bin/node", bin_path, "shell", "--agent", "Robo", "--yes"]
    assert calls[2] == ["/usr/local/bin/node", bin_path, "exec", "--agent", "Robo", "--exec", "my-router --stdin"]
    assert len(opened) == 2, "two widget reopens: the third run passed --no-widget"


def test_run_codex_interactive_wires_a_codex_session_bridge_into_the_pty(monkeypatch):
    popens, ptys = [], []

    class FakeProc:
        def __init__(self, argv, **kw):
            popens.append(argv)
            import os as _os
            r, w = _os.pipe()
            self.stdout = _os.fdopen(r, "rb")
            self.terminated = False
        def terminate(self): self.terminated = True
        def wait(self, timeout=None): return 0

    monkeypatch.setattr(bridge_mod.subprocess, "Popen", FakeProc)
    monkeypatch.setattr(bridge_mod, "_node", lambda: "/usr/local/bin/node")
    from cli import pty_session
    monkeypatch.setattr(pty_session, "run_in_pty", lambda argv, **kw: (ptys.append((argv, kw["cwd"])), 7)[1])
    code = bridge_mod.run_codex_interactive("Robo", "/r", ("--model", "m"))
    assert code == 7
    assert popens == [["/usr/local/bin/node", str(bridge_mod.BRIDGE_BIN), "stdout", "--agent", "Robo", "--runtime", "codex", "--quiet"]]
    assert ptys == [(["codex", "--yolo", "--model", "m"], "/r")]

    # `las codex --yolo` (or the long spelling) must not hand codex the flag twice.
    ptys.clear()
    bridge_mod.run_codex_interactive("Robo", "/r", ("--yolo", "resume", "--dangerously-bypass-approvals-and-sandbox"))
    assert ptys == [(["codex", "--yolo", "resume"], "/r")]


def test_las_codex_refuses_clearly_when_codex_is_missing(monkeypatch, tmp_path):
    calls, *_ = _chain_spies(monkeypatch, tmp_path)
    monkeypatch.setattr(bridge_mod.shutil, "which", lambda name: None if name == "codex" else f"/usr/local/bin/{name}")
    result = CliRunner().invoke(cli, ["codex"])
    assert result.exit_code == 1 and "codex not found" in result.output
    assert calls == []


def test_bridge_claude_outside_an_agent_folder_starts_the_idle_server_instead_of_failing(monkeypatch):
    calls = _capture(monkeypatch)
    monkeypatch.setattr(bridge_mod, "_agent_name_from_cwd", lambda: None)
    result = CliRunner().invoke(cli, ["bridge", "claude"])
    assert result.exit_code == 0, result.output
    assert calls == [["/usr/local/bin/node", str(bridge_mod.BRIDGE_BIN), "claude"]], "no --agent: the Node side goes idle"


def test_las_claude_passes_options_prompts_and_claude_subcommands_through(monkeypatch, tmp_path):
    calls, *_ = _chain_spies(monkeypatch, tmp_path)
    runner = CliRunner()
    flag = [bridge_mod.CLAUDE_CHANNEL_FLAG, bridge_mod.CLAUDE_CHANNEL_SERVER]
    assert runner.invoke(cli, ["claude"]).exit_code == 0
    assert runner.invoke(cli, ["claude", "--resume"]).exit_code == 0
    assert runner.invoke(cli, ["claude", "fix the failing test"]).exit_code == 0
    assert runner.invoke(cli, ["claude", "--model", "opus", "explain this repo"]).exit_code == 0
    assert runner.invoke(cli, ["claude", "mcp", "list"]).exit_code == 0
    assert runner.invoke(cli, ["claude", "--no-widget", "-p", "hi"]).exit_code == 0
    assert calls == [
        ["claude", *flag],
        ["claude", *flag, "--resume"],
        ["claude", *flag, "fix the failing test"],
        ["claude", *flag, "--model", "opus", "explain this repo"],
        ["claude", *flag, "mcp", "list"],
        ["claude", *flag, "-p", "hi"],
    ]


def test_las_claude_help_lists_only_our_scoped_subcommands():
    out = " ".join(CliRunner().invoke(cli, ["claude", "--help"]).output.split())
    assert "register" in out and "unregister" in out
    assert "goes to Claude Code as-is" in out
    assert "No such command" not in out


def test_las_claude_inside_a_claude_session_guides_instead_of_nesting(monkeypatch, tmp_path):
    calls, *_ = _chain_spies(monkeypatch, tmp_path)
    monkeypatch.setenv("CLAUDECODE", "1")
    result = CliRunner().invoke(cli, ["claude", "--resume"])
    assert result.exit_code == 0
    assert "already inside a Claude session" in result.output
    assert "las claude --resume" in result.output and "las shell" in result.output
    assert calls == [], "nothing launched, nothing chained"


def test_las_codex_runs_in_the_current_directory_not_the_agent_root(monkeypatch, tmp_path):
    """Identity from the nearest .las-agent.json upward; working directory = where you launched it."""
    _chain_spies(monkeypatch, tmp_path)
    runs = []
    monkeypatch.setattr(bridge_mod, "run_codex_interactive", lambda name, agent_dir, *a, **k: (runs.append((name, agent_dir)), 0)[1])
    monkeypatch.delenv("LAS_CODEX_CMD", raising=False)
    sub = tmp_path / "RelayRobotics" / "astra-supervisor"
    sub.mkdir(parents=True)
    monkeypatch.chdir(sub)
    assert CliRunner().invoke(cli, ["codex"]).exit_code == 0
    assert runs == [("Robo", str(sub))]


import pytest as _pytest  # noqa: E402


@_pytest.fixture(autouse=True)
def _plain_claude_on_path(monkeypatch):
    """Assertions name `claude`; which native install this machine has is not what these tests check."""
    from cli.commands import bridge as _bridge
    monkeypatch.setattr(_bridge, "claude_bin", lambda: "claude")
