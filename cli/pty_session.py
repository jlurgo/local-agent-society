"""Run an interactive CLI (Codex's TUI, anything) inside a pseudo-terminal
owned by `las`, and type mailbox messages into it.

Why: a TUI has no API to receive a message from outside — Codex has no
equivalent of Claude Code's channels — but every TUI reads its keyboard.
So `las codex` puts `codex --yolo` behind a PTY that `las` controls: the
human's real terminal is forwarded byte for byte in both directions
(raw mode, window size, resize), and whenever the bridge hands over a
mailbox message, it is written into the PTY as a bracketed paste followed
by Enter — exactly what the TUI sees when a person pastes and submits.
Stdlib only (pty/tty/termios/select), no native module, no AppleScript,
works for any interactive program.

A message never lands in the middle of what the human is typing: `las`
watches the keystrokes it forwards (DraftTracker) and holds mailbox messages
while the input line has a draft in it or a key was pressed in the last
moment, typing them in once the human submits or clears the line (or after
`max_hold` seconds of an abandoned draft, so nothing waits forever).

Limits, stated plainly: this is one-way (what the TUI answers stays on
screen; nothing is sent back to the sender), and the draft is estimated from
keystrokes, not read from the TUI — an edit `las` can't size (Ctrl-W, a
mouse selection) can leave it thinking a draft remains until `max_hold`. The
two-way, thread-aware integration is Codex's experimental app-server
(docs/adr/0004 phase 3); this is the terminal the user asked for today.
"""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import tty

BRACKETED_PASTE_START = b"\x1b[200~"
BRACKETED_PASTE_END = b"\x1b[201~"


def format_injection(envelope: dict) -> str:
    """What the TUI receives for one mailbox message: who said it, then the text."""
    sender = envelope.get("from") or "?"
    origin = envelope.get("source") or "agent"
    who = "mic" if origin == "human" else sender
    return f"[LAS message from {who}] {envelope.get('text', '')}"


def _copy_winsize(src_fd: int, dst_fd: int) -> None:
    try:
        size = fcntl.ioctl(src_fd, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
        fcntl.ioctl(dst_fd, termios.TIOCSWINSZ, size)
    except OSError:
        pass


def type_into(master_fd: int, text: str, enter_delay: float = 0.05) -> None:
    """Paste `text` into the PTY (bracketed, so newlines don't submit early) and press Enter."""
    os.write(master_fd, BRACKETED_PASTE_START + text.encode("utf-8", "replace") + BRACKETED_PASTE_END)
    time.sleep(enter_delay)
    os.write(master_fd, b"\r")


class DraftTracker:
    """Estimates, from the raw keystrokes forwarded to the TUI, whether the
    human has something half-typed on the input line."""

    def __init__(self):
        self.chars = 0
        self.last_key = 0.0
        self._esc = False      # inside an escape sequence (arrows, bracketed-paste markers)
        self._csi = False

    def feed(self, data: bytes, now: float) -> None:
        self.last_key = now
        for b in data:
            if self._esc:
                if self._csi:
                    if 0x40 <= b <= 0x7E:  # final byte of a CSI sequence
                        self._esc = self._csi = False
                elif b == 0x5B:  # ESC [
                    self._csi = True
                else:
                    self._esc = False
                continue
            if b == 0x1B:
                self._esc = True
            elif b in (0x0D, 0x0A, 0x03, 0x15):  # Enter submits; Ctrl-C / Ctrl-U clear
                self.chars = 0
            elif b in (0x7F, 0x08):  # backspace
                self.chars = max(0, self.chars - 1)
            elif b >= 0x20 and not (0x80 <= b <= 0xBF):  # printable; skip UTF-8 continuation bytes
                self.chars += 1

    def busy(self, now: float, quiet: float, max_hold: float) -> bool:
        idle = now - self.last_key
        if idle < quiet:
            return True
        return self.chars > 0 and idle < max_hold


def run_in_pty(argv, *, inject_fd=None, stdin_fd=None, stdout_fd=None, on_inject=None, cwd=None, env=None,
               quiet: float = 1.5, max_hold: float = 120.0) -> int:
    """Run `argv` in a PTY, forwarding stdin/stdout, typing each JSON line read
    from `inject_fd` (the bridge's stdout) into it. Returns the child's exit code.

    `stdin_fd`/`stdout_fd` default to the real terminal; tests pass pipes."""
    stdin_fd = sys.stdin.fileno() if stdin_fd is None else stdin_fd
    stdout_fd = sys.stdout.fileno() if stdout_fd is None else stdout_fd
    on_inject = on_inject or format_injection

    pid, master_fd = pty.fork()
    if pid == 0:  # child: become the TUI
        if cwd:
            os.chdir(cwd)
        os.execvpe(argv[0], argv, env or os.environ)

    interactive = os.isatty(stdin_fd)
    saved = termios.tcgetattr(stdin_fd) if interactive else None
    if interactive:
        _copy_winsize(stdin_fd, master_fd)
        signal.signal(signal.SIGWINCH, lambda *_: _copy_winsize(stdin_fd, master_fd))
        tty.setraw(stdin_fd)

    pending = b""
    held = []  # messages waiting for the human to finish typing
    draft = DraftTracker()
    fds = [master_fd, stdin_fd] + ([inject_fd] if inject_fd is not None else [])
    try:
        while True:
            try:
                ready, _, _ = select.select(fds, [], [], 0.25 if held else None)
            except InterruptedError:
                continue
            if master_fd in ready:
                try:
                    data = os.read(master_fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    break  # TUI exited
                os.write(stdout_fd, data)
            if stdin_fd in ready:
                data = os.read(stdin_fd, 65536)
                if not data:
                    fds.remove(stdin_fd)  # test pipes close; a real terminal never does
                else:
                    draft.feed(data, time.monotonic())
                    os.write(master_fd, data)
            if inject_fd is not None and inject_fd in ready:
                chunk = os.read(inject_fd, 65536)
                if not chunk:
                    fds.remove(inject_fd)
                    inject_fd = None
                    continue
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        envelope = json.loads(line.decode("utf-8"))
                    except (ValueError, UnicodeDecodeError):
                        continue
                    held.append(on_inject(envelope))
            while held and not draft.busy(time.monotonic(), quiet, max_hold):
                type_into(master_fd, held.pop(0))
    finally:
        if saved is not None:
            termios.tcsetattr(stdin_fd, termios.TCSADRAIN, saved)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)
