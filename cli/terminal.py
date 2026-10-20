"""The terminal a session lives in: which runtime this command runs under,
which tty a session owns, and the window title (the terminal's own signpost,
next to the widget's — SKILL.md §10).

Why ancestry alone is not enough (2026-10-14): Codex runs every command
through its app-server daemon, a long-lived process re-parented to launchd
and shared by every Codex TUI on the Mac. A command the model runs is a child
of the daemon, never of the TUI or of `las codex` — so there is no `las`
process among its ancestors to name the session. The daemon does keep one
thing per TUI: the working directory. Ancestry still names the runtime (the
daemon's binaries are called codex*), and runtime + cwd name the session.
"""
from __future__ import annotations

import io
import os
import signal
import subprocess
import sys

TITLE_OSC = "\033]2;{text}\007"   # xterm "set window title"; Ghostty, iTerm2, WezTerm, kitty, tmux (passthrough)


def _ps(args: list) -> str:
    try:
        return subprocess.run(["ps", *args], capture_output=True, text=True, timeout=2).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def parent_and_comm(pid: int) -> tuple[int | None, str]:
    out = _ps(["-o", "ppid=,comm=", "-p", str(pid)]).split(None, 1)
    try:
        return int(out[0]), (out[1] if len(out) > 1 else "")
    except (IndexError, ValueError):
        return None, ""


def ancestors(pid: int | None = None) -> list:
    """[(pid, comm)] of this process's ancestors, nearest first; launchd/init excluded."""
    seen, out = set(), []
    pid, comm = parent_and_comm(pid or os.getpid())
    while pid and pid > 1 and pid not in seen:
        seen.add(pid)
        out.append((pid, comm))
        pid, comm = parent_and_comm(pid)
    return out


def runtime_hint(ancestor_comms: list, env: dict | None = None) -> str | None:
    """Which runtime a command runs under, from what it can see of its own
    process tree: Claude Code exports CLAUDECODE to everything it runs (the
    account decides claude vs claudeRelay); Codex's daemon and TUI binaries
    are all called codex*. None when neither — a plain shell, or a cron."""
    env = os.environ if env is None else env
    if env.get("CLAUDECODE"):
        from cli.commands.bridge import claude_runtime
        return claude_runtime()
    if any(os.path.basename(comm).startswith("codex") for comm in ancestor_comms):
        return "codex"
    return None


def tty_of_pid(pid: int | None) -> str | None:
    """The controlling terminal of `pid` as a device path, or None (no tty, gone)."""
    if not pid:
        return None
    tty = _ps(["-o", "tty=", "-p", str(pid)])
    if not tty or tty == "??":
        return None
    return tty if tty.startswith("/") else f"/dev/{tty}"


def session_title_text(agent: str, title: str, runtime: str | None = None) -> str:
    """What the window says: the agent first (the signpost), then the work."""
    head = f"{agent} · {runtime}" if runtime else agent
    return f"{head} — {title}" if title else head


def stdout_fd() -> int | None:
    """The real stdout's descriptor, or None when stdout is not a file (a test runner's capture)."""
    try:
        return sys.stdout.fileno()
    except (AttributeError, OSError, ValueError, io.UnsupportedOperation):
        return None


def _write(data: bytes, tty: str | None = None, fd: int | None = None) -> bool:
    try:
        if fd is not None:
            if not os.isatty(fd):
                return False
            os.write(fd, data)
            return True
        if tty:
            with open(tty, "wb", buffering=0) as handle:
                handle.write(data)
            return True
    except OSError:
        return False
    return False


def set_terminal_title(text: str, tty: str | None = None, fd: int | None = None) -> bool:
    """Write the title escape to a tty path, or to an fd (the real stdout of a
    launcher). Best effort: False when there is no terminal to write to."""
    return _write(TITLE_OSC.format(text=" ".join(text.split())).encode(), tty, fd)


def ring_bell(tty: str) -> bool:
    """BEL on a tty: the terminal's own "look here" (Ghostty marks the tab, the dock bounces)."""
    return _write(b"\a", tty)


def hangup_tty(tty: str) -> bool:
    """SIGHUP every process on `tty` — what a terminal sends when its window
    closes: the runtime exits, the shell exits, the terminal closes the window.
    Listed with `ps -t`: macOS pkill/pgrep -t match nothing. The root-owned
    login refuses the signal and exits once its shell does. True if any got it."""
    hung = False
    for pid in _ps(["-t", os.path.basename(tty), "-o", "pid="]).split():
        try:
            os.kill(int(pid), signal.SIGHUP)
            hung = True
        except (OSError, ValueError):
            pass
    return hung
