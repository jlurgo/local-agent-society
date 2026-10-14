"""`las agent title` finds the session it runs inside — by process ancestry,
or by runtime + working directory when the runtime hides the tree (Codex's
app-server daemon, 2026-10-14) — and puts the title on the terminal too."""
import os

from click.testing import CliRunner

from cli import terminal
from cli.commands import agents
from cli.main import cli


def test_own_session_by_ancestry(monkeypatch):
    parents = {10: 5, 20: 7, 30: 5}
    monkeypatch.setattr(agents, "_parent_pid", lambda pid: parents.get(pid))
    claude = {"sid": "claude-10", "pid": 10}   # bridge started by Claude (pid 5)
    codex = {"sid": "codex-20", "pid": 20}     # bridge started by `las codex` (pid 7)
    shell = {"sid": "shell-40", "pid": 40}     # the bridge IS an ancestor of what it runs
    assert agents.own_session([claude, codex], {5, 3})["sid"] == "claude-10"
    assert agents.own_session([claude, codex], {7, 3})["sid"] == "codex-20"
    assert agents.own_session([claude, codex, shell], {40, 3})["sid"] == "shell-40"
    assert agents.own_session([claude, codex], {99}) is None
    twin = {"sid": "claude-30", "pid": 30}     # two bridges under one parent: ambiguous, ask for --session
    assert agents.own_session([claude, twin], {5}) is None


def test_own_session_by_runtime_and_cwd_when_ancestry_says_nothing(monkeypatch, tmp_path):
    monkeypatch.setattr(agents, "_parent_pid", lambda pid: None)
    here, there = tmp_path / "team-knowledge", tmp_path / "brain"
    codex_here = {"sid": "codex-1", "pid": 1, "runtime": "codex", "cwd": str(here)}
    codex_there = {"sid": "codex-2", "pid": 2, "runtime": "codex", "cwd": str(there)}
    claude_here = {"sid": "claude-3", "pid": 3, "runtime": "claude", "cwd": str(here)}
    sessions = [codex_here, codex_there, claude_here]
    # Under Codex's daemon no ancestor is ours; the daemon keeps the TUI's cwd.
    assert agents.own_session(sessions, set(), "codex", str(here))["sid"] == "codex-1"
    assert agents.own_session(sessions, set(), "codex", str(there))["sid"] == "codex-2"
    # Only one session of the runtime at all: that one, wherever the command runs.
    assert agents.own_session(sessions, set(), "claude", str(tmp_path))["sid"] == "claude-3"
    # Two of the runtime and no cwd match: still ambiguous.
    assert agents.own_session(sessions, set(), "codex", str(tmp_path)) is None
    # No runtime hint (a plain shell): never a guess.
    assert agents.own_session(sessions, set(), None, str(here)) is None


def test_runtime_hint_from_the_process_tree(monkeypatch):
    monkeypatch.delenv("CLAUDECODE", raising=False)
    daemon = ["/bin/zsh", "/Users/x/.codex/packages/app-server-daemon/releases/0.162.1/bin/codex", "launchd"]
    assert terminal.runtime_hint(daemon) == "codex"
    assert terminal.runtime_hint(["/bin/zsh", "codex-code-mode-host"]) == "codex"
    assert terminal.runtime_hint(["/bin/zsh", "ghostty"]) is None
    assert terminal.runtime_hint(["node", "/Users/x/.local/bin/claude"], {"CLAUDECODE": "1", "CLAUDE_CONFIG_DIR": ""}) == "claude"


def test_title_lands_on_the_sessions_terminal(monkeypatch, tmp_path):
    view = {"agent": "Robo", "default": "codex-1", "sessions": [
        {"sid": "codex-1", "runtime": "codex", "pid": 4242, "cwd": "/r", "lastActiveAt": 0, "default": True, "title": ""},
    ]}
    puts = []
    monkeypatch.setattr(agents.api, "get", lambda path: {"Robo": {}} if path == "/agents" else view)
    monkeypatch.setattr(agents.api, "put", lambda path, data=None: (puts.append((path, data)), view)[1])
    monkeypatch.setattr(terminal, "ancestors", lambda pid=None: [(99, "/x/bin/codex")])
    monkeypatch.delenv("CLAUDECODE", raising=False)
    fake_tty = tmp_path / "ttys042"
    fake_tty.write_bytes(b"")
    monkeypatch.setattr(terminal, "tty_of_pid", lambda pid: str(fake_tty) if pid == 4242 else None)
    result = CliRunner().invoke(cli, ["agent", "title", "Decisiones Brain", "--name", "Robo"])
    assert result.exit_code == 0, result.output
    assert puts == [("/agents/Robo/sessions/codex-1/title", {"title": "Decisiones Brain"})]
    assert fake_tty.read_bytes() == b"\x1b]2;Robo \xc2\xb7 codex \xe2\x80\x94 Decisiones Brain\x07"
    assert "Decisiones Brain" in result.output and str(fake_tty) in result.output


def test_title_without_a_session_of_its_own_asks_for_the_flag(monkeypatch):
    view = {"agent": "Robo", "default": "codex-1", "sessions": [
        {"sid": "codex-1", "runtime": "codex", "pid": 1, "cwd": "/r", "lastActiveAt": 0, "default": True},
        {"sid": "codex-2", "runtime": "codex", "pid": 2, "cwd": "/s", "lastActiveAt": 0, "default": False},
    ]}
    monkeypatch.setattr(agents.api, "get", lambda path: {"Robo": {}} if path == "/agents" else view)
    monkeypatch.setattr(terminal, "ancestors", lambda pid=None: [(99, "/x/bin/codex")])
    monkeypatch.delenv("CLAUDECODE", raising=False)
    monkeypatch.chdir(os.path.dirname(__file__))
    result = CliRunner().invoke(cli, ["agent", "title", "x", "--name", "Robo"])
    assert result.exit_code == 1 and "pass --session" in result.output


def test_set_terminal_title_is_best_effort(tmp_path):
    assert terminal.set_terminal_title("x", tty=str(tmp_path / "missing" / "tty")) is False
    r, w = os.pipe()
    try:
        assert terminal.set_terminal_title("x", fd=w) is False   # a pipe is not a terminal
    finally:
        os.close(r)
        os.close(w)
    assert terminal.session_title_text("Robo", "", "codex") == "Robo · codex"
    assert terminal.session_title_text("Robo", "Ships", None) == "Robo — Ships"
