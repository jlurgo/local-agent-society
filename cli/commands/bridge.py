"""`las bridge` / `las claude` — deliver this agent's vortexia mailbox into
a session runtime.

The consumer itself (mailbox session, interceptor pipeline, sinks) is ONE
implementation, in Node: bridge/bin/las-bridge.js (see docs/adr/0004). This
module only knows how to launch it for a given sink, where its status file
lives, and how to register it with Claude Code as a channel.

One command per runtime, each run from that runtime's own terminal, each
chaining everything the session needs (MCP registration, presence, the
widget on this Space) before handing over — see `_chain`:
  las claude [args]   Claude Code with the LAS channel
  las codex           Codex's own TUI (`codex --yolo`) in a PTY, mailbox messages typed into it
  las shell           a terminal with no AI in it

Claude's own config lives under its own scope: `las claude register|unregister`
(Codex and the shell need no registration — their commands launch the bridge
directly).

Two Claude accounts on one Mac: Claude Code keeps a login per
CLAUDE_CONFIG_DIR. `las claude --account relay` (or CLAUDE_CONFIG_DIR set by
hand) opens Claude with ~/.claude-relay as its config dir, registers the
channel in THAT dir's .claude.json, and the session shows up as runtime
`claudeRelay` next to the personal `claude` one — its own sid, its own
mailbox, its own status file, so neither steals the other's delivery.

Sinks (the low-level `las bridge <sink>` form):
  claude   Claude Code channel — normally started by Claude Code itself from
           ~/.claude.json (see `las claude register`); run by hand only to debug
  stdout   one JSON line per message (a script, a log, a plain terminal)
  shell    a terminal with no AI in it: print messages, offer kind="command"
           ones to run in the agent's folder (confirmed on the TTY)
  exec     run any command per message — Codex, a local model, a router —
           with the text on stdin, and send its output back to the sender
"""
import errno
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

import click

from cli import api
from cli.commands import complete_agent_names
from cli.commands._agent_common import _agent_name_from_cwd, resolve_agent_name

REPO = Path(__file__).resolve().parents[2]
BRIDGE_BIN = REPO / "bridge" / "bin" / "las-bridge.js"
SESSION_DIR = REPO / "session"

# Research-preview flag: custom channels aren't on Claude Code's allowlist
# yet, so every session that should receive the mailbox must be started with
# it. `las claude` exists so nobody types it by hand.
CLAUDE_CHANNEL_FLAG = "--dangerously-load-development-channels"
MCP_SERVER_NAME = "las"
CLAUDE_CHANNEL_SERVER = f"server:{MCP_SERVER_NAME}"


# What to do from INSIDE a session that has no channel (opened as bare
# `claude`, or from an IDE): the channel is a launch flag, nothing can add it
# to a live session — but Claude Code restores a conversation, so the way
# in is to leave and come back through `las`. Printed by `las bridge status`
# and by `las claude` when it is (mistakenly) run inside Claude.
RECONNECT_GUIDE = (
    "To connect THIS conversation to LAS:\n"
    "  1. exit Claude (Ctrl+C twice, or /exit)\n"
    "  2. in the same folder run:  las claude --resume\n"
    "     (it restores this conversation with the LAS channel on; the mailbox kept every message meanwhile)\n"
    "  A plain terminal instead?  las shell    Codex?  las codex"
)


def reconnect_guide() -> str:
    """RECONNECT_GUIDE, naming the account when this shell belongs to a non-default Claude config dir."""
    account = claude_account()
    if not account:
        return RECONNECT_GUIDE
    command = "las claudeRelay" if account == RELAY_ACCOUNT else f"las claude --account {account}"
    return RECONNECT_GUIDE.replace("las claude --resume", f"{command} --resume")


def inside_claude_session() -> bool:
    """Claude Code sets CLAUDECODE in the shells it spawns (its `!` prompt, Bash tool)."""
    return bool(os.environ.get("CLAUDECODE"))


DEFAULT_CLAUDE_RUNTIME = "claude"


def claude_config_dir() -> Path | None:
    """The Claude config dir in effect when it is NOT the default one (~/.claude) — None for the default."""
    raw = os.environ.get("CLAUDE_CONFIG_DIR")
    if not raw:
        return None
    path = Path(raw).expanduser()
    return None if path.resolve() == (Path.home() / ".claude").resolve() else path


def account_config_dir(account: str) -> Path:
    """`--account relay` -> ~/.claude-relay."""
    return Path.home() / f".claude-{account}"


def claude_account() -> str | None:
    """The account name behind a non-default config dir: ~/.claude-relay -> "relay"; any other dir -> its name."""
    path = claude_config_dir()
    if path is None:
        return None
    stem = path.name.lstrip(".")
    if stem.startswith("claude") and stem[6:7] in ("-", "_"):
        stem = stem[7:]
    return stem or None


def claude_runtime() -> str:
    """The runtime name this Claude session registers as: "claude" for the default
    account, "claude" + CamelCased account otherwise (~/.claude-relay -> "claudeRelay").
    LAS_CLAUDE_RUNTIME overrides both."""
    explicit = os.environ.get("LAS_CLAUDE_RUNTIME")
    if explicit:
        return explicit
    account = claude_account()
    if not account:
        return DEFAULT_CLAUDE_RUNTIME
    return DEFAULT_CLAUDE_RUNTIME + "".join(part[:1].upper() + part[1:] for part in account.replace("_", "-").split("-") if part)


def claude_config_path() -> Path:
    """Claude Code's user-level config (mcpServers live here, not in settings.json).

    LAS_CLAUDE_CONFIG wins; otherwise Claude Code's own rule — the file lives
    INSIDE CLAUDE_CONFIG_DIR when that is set, at ~/.claude.json when not."""
    if os.environ.get("LAS_CLAUDE_CONFIG"):
        return Path(os.environ["LAS_CLAUDE_CONFIG"])
    config_dir = claude_config_dir()
    return config_dir / ".claude.json" if config_dir else Path.home() / ".claude.json"


def _node_candidates() -> list:
    """Where a Node binary may live when PATH doesn't say (Claude Code spawns
    MCP servers with whatever PATH its own launcher had — a GUI-launched or
    non-login shell often has no nvm in it): nvm's newest install, then
    Homebrew, then the classic /usr/local."""
    nvm = sorted((Path.home() / ".nvm/versions/node").glob("v*/bin/node"), key=lambda q: [int(x) for x in q.parts[-3][1:].split(".") if x.isdigit()], reverse=True)
    return [str(q) for q in nvm] + ["/opt/homebrew/bin/node", "/usr/local/bin/node"]


def _node() -> str:
    node = shutil.which("node")
    if node:
        return node
    for candidate in _node_candidates():
        if os.access(candidate, os.X_OK):
            return candidate
    click.echo("Error: node not found (PATH, nvm, Homebrew) — the bridge is a Node program (see bridge/).", err=True)
    raise SystemExit(1)


# Where Claude Code's native installer puts `claude`. Preferred over PATH:
# a shell often reaches the native build through an alias (which exec never
# sees) while PATH still holds an old npm global whose native binary is
# missing — on uy-mac that stub failed with "Exec format error" and then
# "claude native binary not installed", while `claude` typed by hand worked.
NATIVE_CLAUDE_PATHS = ("~/.local/bin/claude", "~/.claude/local/claude")


def claude_bin() -> str:
    for candidate in NATIVE_CLAUDE_PATHS:
        path = os.path.expanduser(candidate)
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return "claude"


def _is_text_script(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            head = f.read(512)
    except OSError:
        return False
    return bool(head) and b"\0" not in head


def _exec(argv):
    """Replace this process — the bridge owns stdio from here on (for the
    claude sink stdout IS the MCP wire).

    A shell runs a script that has no `#!` line with /bin/sh; execvp does
    not, it fails with ENOEXEC ("Exec format error") — seen with a `claude`
    wrapper on uy-mac that worked typed by hand. Do what the shell does. A
    binary the kernel still refuses (wrong architecture, truncated) gets a
    clear message instead of a traceback.
    """
    try:
        os.execvp(argv[0], argv)
    except OSError as exc:
        if exc.errno != errno.ENOEXEC:
            raise
        path = shutil.which(argv[0]) or argv[0]
        if _is_text_script(path):
            os.execv("/bin/sh", ["/bin/sh", path, *argv[1:]])
        click.echo(f"Error: {path} is not a runnable program on this Mac (Exec format error) — "
                   f"check `file {path}`; reinstall it if it is for another architecture or truncated.", err=True)
        raise SystemExit(1)


def bridge_argv(sink: str, name: str, extra=()) -> list:
    return [_node(), str(BRIDGE_BIN), sink, "--agent", name, *extra]


def _common(extra: list, intercept_url, port):
    if intercept_url:
        extra += ["--intercept-url", intercept_url]
    if port:
        extra += ["--port", str(port)]
    return extra


@click.group()
def bridge():
    """Deliver this agent's vortexia mailbox into a session runtime (Claude channel, shell, any command)."""


_name_arg = click.argument("name", required=False, shell_complete=complete_agent_names)
_intercept = click.option("--intercept-url", default=None, help="First-decision hook: POST each message here first (fails open).")
_port = click.option("--port", default=None, type=int, help="Broker MQTT port (default: vortexia.port.json, then the registry).")


@bridge.command("claude")
@_name_arg
@click.option("--runtime", default=None, help="Runtime name this session registers as (default: from CLAUDE_CONFIG_DIR — claude, claudeRelay...).")
@_intercept
@_port
def bridge_claude(name, runtime, intercept_url, port):
    """Run the Claude Code channel server (Claude Code starts this itself from ~/.claude.json).

    Outside an agent folder it still starts — as an idle, empty server — so a
    Claude session in any other project never shows a failed MCP server."""
    name = name or _agent_name_from_cwd()
    runtime = runtime or claude_runtime()
    extra = _common(["--runtime", runtime] if runtime != DEFAULT_CLAUDE_RUNTIME else [], intercept_url, port)
    argv = bridge_argv("claude", name, extra) if name else [_node(), str(BRIDGE_BIN), "claude", *extra]
    _exec(argv)


@bridge.command("stdout")
@_name_arg
@_intercept
@_port
def bridge_stdout(name, intercept_url, port):
    """Print one JSON line per message (what `las agent listen` printed)."""
    name = resolve_agent_name(name)
    _exec(bridge_argv("stdout", name, _common([], intercept_url, port)))


@bridge.command("shell")
@_name_arg
@click.option("--yes", is_flag=True, help="Run kind=command messages without asking on the TTY.")
@click.option("--all", "run_all", is_flag=True, help="Offer EVERY message to run, not only kind=command.")
@_intercept
@_port
def bridge_shell(name, yes, run_all, intercept_url, port):
    """A terminal with no AI: print messages, run the ones that are commands (after a y/N)."""
    name = resolve_agent_name(name)
    extra = (["--yes"] if yes else []) + (["--all"] if run_all else [])
    _exec(bridge_argv("shell", name, _common(extra, intercept_url, port)))


@bridge.command("exec")
@_name_arg
@click.option("--exec", "command", required=True, help='Command run per message, text on stdin, e.g. --exec "codex exec --yolo -".')
@_intercept
@_port
def bridge_exec(name, command, intercept_url, port):
    """Feed every message to a command (Codex, a local model, a router) and send its output back."""
    name = resolve_agent_name(name)
    _exec(bridge_argv("exec", name, _common(["--exec", command], intercept_url, port)))


def _pid_alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def read_statuses(name: str) -> list:
    """Every live bridge's status file for `name` — one per session (`bridge-<name>@<sid>.json`),
    plus the per-agent file older bridges wrote. Dead pids are skipped."""
    paths = sorted(SESSION_DIR.glob(f"bridge-{name}@*.json")) + [SESSION_DIR / f"bridge-{name}.json"]
    return [s for s in (_read_json(p) for p in paths) if s and _pid_alive(s.get("pid"))]


def read_status(name: str) -> dict | None:
    """THIS session's bridge (found by process ancestry, like `las agent title`) when there is
    one; otherwise the only live bridge, or an armed one, so a plain terminal still gets an answer."""
    from cli.commands.agents import _ancestor_pids, own_session
    statuses = read_statuses(name)
    if not statuses:
        return None
    mine = own_session(statuses, _ancestor_pids()) if len(statuses) > 1 else statuses[0]
    if mine:
        return mine
    return next((s for s in statuses if s.get("armed")), statuses[0])


@bridge.command("status")
@_name_arg
def bridge_status(name):
    """Is a bridge delivering this agent's mailbox right now? Exit 0 only when one is running AND armed."""
    name = resolve_agent_name(name)
    status = read_status(name)
    if not status:
        click.echo(f"{name}: no bridge running — messages wait in the mailbox.")
        click.echo(reconnect_guide())
        raise SystemExit(1)
    armed = bool(status.get("armed"))
    sink = status.get("sink", "?")
    delivered = status.get("delivered", 0)
    state = "armed" if armed else "waiting for the session to ack the channel probe"
    runtime = f" ({status['runtime']})" if status.get("runtime") else ""
    click.echo(f"{name}: {sink} bridge pid {status.get('pid')}{runtime} — {state}, {delivered} delivered.")
    raise SystemExit(0 if armed else 1)


def _las() -> str:
    """The `las` console script itself — a stable path (pipx shim) that does not
    depend on which shell ran the registration. Registering an absolute `node`
    path here once broke every session: the path was whatever `which node`
    said in the shell that happened to run `las claude`, and a shell without
    nvm produced a binary that did not exist. `las bridge claude` resolves
    node at spawn time instead (see _node)."""
    return shutil.which("las") or sys.argv[0] or "las"


def mcp_server_entry() -> dict:
    """The `las` entry for the config in effect. A non-default account's entry names
    its runtime explicitly, so the channel registers as claudeRelay even if Claude
    Code ever stops handing CLAUDE_CONFIG_DIR down to the servers it spawns."""
    runtime = claude_runtime()
    args = ["bridge", "claude"] + (["--runtime", runtime] if runtime != DEFAULT_CLAUDE_RUNTIME else [])
    return {"command": _las(), "args": args}


def _entry_is_usable(entry) -> bool:
    """An entry we (or an older version of us) wrote, for THIS config's runtime, whose command still exists."""
    if not isinstance(entry, dict) or not isinstance(entry.get("args"), list):
        return False
    args = entry["args"]
    runtime = claude_runtime()
    if runtime != DEFAULT_CLAUDE_RUNTIME:
        ours = args == mcp_server_entry()["args"]
    else:
        ours = args == ["bridge", "claude"] or (args[:1] == [str(BRIDGE_BIN)] and args[-1:] == ["claude"])
    return ours and os.access(str(entry.get("command", "")), os.X_OK)


def ensure_mcp_registered(quiet=True) -> bool:
    """Idempotent `las claude register` — True when the entry is (now) present."""
    path = claude_config_path()
    try:
        config = json.loads(path.read_text()) if path.exists() else {}
    except ValueError:
        return False
    servers = config.setdefault("mcpServers", {})
    # Leave a working entry alone — even an older-shaped one — so a chain run
    # from an odd shell can never downgrade a good registration into a broken
    # one. Only a missing or broken entry gets (re)written.
    if _entry_is_usable(servers.get(MCP_SERVER_NAME)):
        return True
    servers[MCP_SERVER_NAME] = mcp_server_entry()
    path.write_text(json.dumps(config, indent=2) + "\n")
    if not quiet:
        click.echo(f"{path}: `{MCP_SERVER_NAME}` MCP server registered.")
    return True


def _register_presence(name: str) -> bool:
    """`las agent register`, fail-soft: a backend that is down must not stop a session from opening."""
    try:
        result = api.post(f"/agents/{name}/vortexia/register", {})
        return bool(result and result.get("registered"))
    except SystemExit:
        return False


def _reopen_widget(name: str) -> None:
    """Same URL-scheme reopen `las widget` does: the widget lands on THIS Space, the one the terminal is on."""
    if sys.platform != "darwin":
        return
    subprocess.run(["open", f"localagentsociety://{quote(name, safe='')}?action=reopen"], check=False)


def _chain(name: str | None, *, widget: bool = True) -> None:
    """Everything a runtime session needs, in one go, before the runtime takes
    the terminal over: the `las` MCP server registered (so Claude finds the
    channel), presence published (so `las agents`/the widget show this agent
    online), and the widget brought to this Space. Each step fails soft and
    says nothing when it has nothing to say — the human typed ONE command."""
    if not name:
        return
    ensure_mcp_registered()
    if not _register_presence(name):
        click.echo(f"{name}: backend unreachable — presence not published (session opens anyway).", err=True)
    if widget:
        _reopen_widget(name)


# What a second account shares with the personal one: the same instructions,
# settings, skills and hooks — symlinked, so editing ~/.claude updates both.
# The login (Keychain entry) and .claude.json stay per account.
SHARED_CLAUDE_ENTRIES = ("CLAUDE.md", "settings.json", "skills", "hooks", "statusline-command.sh")


def ensure_account_dir(config_dir: Path, home_claude: Path | None = None) -> list:
    """Create `config_dir` and symlink each shared entry from ~/.claude that it lacks.
    Never replaces anything already there. Returns the names it linked."""
    home_claude = home_claude or Path.home() / ".claude"
    config_dir.mkdir(parents=True, exist_ok=True)
    linked = []
    for entry in SHARED_CLAUDE_ENTRIES:
        source, target = home_claude / entry, config_dir / entry
        if source.exists() and not target.exists() and not target.is_symlink():
            target.symlink_to(source)
            linked.append(entry)
    return linked


def _use_account(account: str | None) -> None:
    """`--account relay`: Claude Code (exec'd below, inheriting this env) logs in and keeps its
    config under ~/.claude-relay; registration and the runtime name follow from it."""
    if account:
        config_dir = account_config_dir(account)
        ensure_account_dir(config_dir)
        os.environ["CLAUDE_CONFIG_DIR"] = str(config_dir)
        # A stale override for another account must not redirect the registration.
        os.environ.pop("LAS_CLAUDE_CONFIG", None)


def _launch_claude(args, no_widget=False, account=None):
    if inside_claude_session():
        # Not a launch: nested Claude with no TTY would just error. Guide instead.
        click.echo("You are already inside a Claude session — `las claude` opens a NEW one from a terminal.")
        click.echo(reconnect_guide())
        raise SystemExit(0)
    _use_account(account)
    if not shutil.which("claude"):
        click.echo("Error: claude not found on PATH.", err=True)
        raise SystemExit(1)
    _chain(_agent_name_from_cwd(), widget=not no_widget)
    _exec([claude_bin(), CLAUDE_CHANNEL_FLAG, CLAUDE_CHANNEL_SERVER, *args])


class ClaudeGroup(click.Group):
    """`las claude` is scoped like `las agent`: its own subcommands (register,
    unregister) are ours; ANY other token — `--resume`, a prompt, `mcp list` —
    belongs to Claude Code and is passed through untouched. An unknown first
    token therefore becomes a pass-through launch instead of "No such command"."""

    def get_command(self, ctx, name):
        cmd = super().get_command(ctx, name)
        if cmd is not None:
            return cmd

        @click.command(name, add_help_option=False, context_settings={"ignore_unknown_options": True, "allow_extra_args": True})
        @click.argument("rest", nargs=-1, type=click.UNPROCESSED)
        @click.pass_context
        def passthrough(pctx, rest):
            parent = pctx.parent
            obj = parent.obj or {}
            _launch_claude([*parent.args, name, *rest], obj.get("no_widget", False), obj.get("account"))

        return passthrough

    def list_commands(self, ctx):
        return sorted(self.commands)


@click.group("claude", cls=ClaudeGroup, invoke_without_command=True, context_settings={"ignore_unknown_options": True, "allow_extra_args": True})
@click.option("--no-widget", is_flag=True, help="Don't bring this agent's widget to the current Space.")
@click.option("--account", default=None, metavar="NAME", help="Another Claude login on this Mac: config in ~/.claude-NAME, session shown as runtime claudeNAME (e.g. --account relay -> claudeRelay).")
@click.pass_context
def claude_cmd(ctx, no_widget, account):
    """Claude Code, connected to LAS: `las claude [claude args]` starts it here with the channel on, presence published and the widget on this Space.

    Everything after `las claude` that isn't one of the subcommands below goes to Claude Code as-is (`--resume`, a prompt, `mcp list`...).
    `--account relay` (or CLAUDE_CONFIG_DIR=~/.claude-relay) opens a second Claude account alongside the personal one.
    """
    ctx.obj = {"no_widget": no_widget, "account": account}
    if ctx.invoked_subcommand is None:
        _launch_claude(list(ctx.args), no_widget, account)
    else:
        # `las claude --account relay register` repairs THAT account's config.
        _use_account(account)


@claude_cmd.command("register")
@click.option("--force", is_flag=True, help="Rewrite the entry even if a working one exists.")
def claude_register(force):
    """Register the LAS channel server in Claude Code's own config (~/.claude.json). `las claude` does this by itself; use it to repair."""
    path = claude_config_path()
    try:
        config = json.loads(path.read_text()) if path.exists() else {}
    except ValueError:
        click.echo(f"Error: {path} is not valid JSON — not touching it.", err=True)
        raise SystemExit(1)
    servers = config.setdefault("mcpServers", {})
    entry = mcp_server_entry()
    current = servers.get(MCP_SERVER_NAME)
    if current == entry or (not force and _entry_is_usable(current)):
        click.echo(f"{path}: `{MCP_SERVER_NAME}` MCP server already registered -> {current['command']} {' '.join(current['args'])}")
    else:
        servers[MCP_SERVER_NAME] = entry
        path.write_text(json.dumps(config, indent=2) + "\n")
        click.echo(f"{path}: `{MCP_SERVER_NAME}` MCP server registered -> {entry['command']} {' '.join(entry['args'])}")
    click.echo(f"Start sessions with `las claude` (adds {CLAUDE_CHANNEL_FLAG} {CLAUDE_CHANNEL_SERVER}).")


@claude_cmd.command("unregister")
def claude_unregister():
    """Remove the LAS channel server from Claude Code's config."""
    path = claude_config_path()
    try:
        config = json.loads(path.read_text()) if path.exists() else {}
    except ValueError:
        click.echo(f"Error: {path} is not valid JSON — not touching it.", err=True)
        raise SystemExit(1)
    servers = config.setdefault("mcpServers", {})
    removed = servers.pop(MCP_SERVER_NAME, None) is not None
    path.write_text(json.dumps(config, indent=2) + "\n")
    click.echo(f"{path}: `{MCP_SERVER_NAME}` MCP server {'removed' if removed else 'was not registered'}.")


RELAY_ACCOUNT = "relay"


@click.command("claudeRelay", context_settings={"ignore_unknown_options": True, "allow_extra_args": True, "help_option_names": []})
@click.option("--no-widget", is_flag=True, help="Don't bring this agent's widget to the current Space.")
@click.argument("claude_args", nargs=-1, type=click.UNPROCESSED)
def claude_relay_cmd(no_widget, claude_args):
    """Claude Code on the second (company) account, connected to LAS — `las claude --account relay`.

    Config in ~/.claude-relay (created on first use, sharing CLAUDE.md/settings/skills/hooks with
    ~/.claude by symlink), session shown as runtime claudeRelay. First run: /login with that account.
    Every argument goes to Claude Code as-is (`--resume`, a prompt...).
    """
    _launch_claude(list(claude_args), no_widget, RELAY_ACCOUNT)


# `codex --yolo` — the exact command the user runs by hand — opened inside a
# PTY that `las` owns (cli/pty_session.py), so each mailbox message can be
# typed into Codex's composer as a paste + Enter. Codex has no channel-like
# API for an interactive session; its keyboard is the only way in.
CODEX_ARGV = ["codex", "--yolo"]
# Spellings of the flag CODEX_ARGV already carries. Typing `las codex --yolo`
# out of habit must not pass it twice — codex refuses a repeated
# --dangerously-bypass-approvals-and-sandbox and exits before opening.
CODEX_YOLO_FLAGS = {"--yolo", "--dangerously-bypass-approvals-and-sandbox"}
# The headless alternative (`--exec`): one `codex exec` per message, text on
# stdin, answer sent back to the sender. --yolo there too: nobody is at the
# keyboard to approve anything in a run driven by the mailbox.
CODEX_DEFAULT_CMD = "codex exec --yolo -"


def run_codex_interactive(name: str, agent_dir: str, codex_args=(), intercept_url=None, port=None) -> int:
    """Codex's TUI in front, the bridge behind: `las-bridge stdout` consumes this
    agent's mailbox as a `codex` session and every JSON line it prints is typed
    into the TUI. Returns Codex's exit code; the bridge dies with it."""
    from cli import pty_session
    bridge = subprocess.Popen(
        bridge_argv("stdout", name, _common(["--runtime", "codex", "--quiet"], intercept_url, port)),
        stdout=subprocess.PIPE, stdin=subprocess.DEVNULL,
    )
    try:
        extra = [a for a in codex_args if a not in CODEX_YOLO_FLAGS]
        return pty_session.run_in_pty([*CODEX_ARGV, *extra], inject_fd=bridge.stdout.fileno(), cwd=agent_dir)
    finally:
        bridge.terminate()
        try:
            bridge.wait(timeout=5)
        except subprocess.TimeoutExpired:
            bridge.kill()


@click.command("codex", context_settings={"ignore_unknown_options": True, "allow_extra_args": True})
@click.option("--exec", "command", default=None, help=f'Headless instead of the TUI: run this command per message, text on stdin (e.g. "{CODEX_DEFAULT_CMD}", or $LAS_CODEX_CMD).')
@click.option("--no-widget", is_flag=True, help="Don't bring this agent's widget to the current Space.")
@_intercept
@_port
@click.argument("codex_args", nargs=-1, type=click.UNPROCESSED)
def codex_cmd(command, no_widget, intercept_url, port, codex_args):
    """Codex here, connected to LAS: opens `codex --yolo` (extra args pass through) and types every mailbox message into it.

    With --exec, no TUI: each message becomes a headless `codex exec` run whose answer goes back to the sender.
    """
    name = resolve_agent_name(None)
    if not shutil.which("codex") and not command:
        click.echo("Error: codex not found on PATH (install the Codex CLI, or pass --exec).", err=True)
        raise SystemExit(1)
    _chain(name, widget=not no_widget)
    if command or os.environ.get("LAS_CODEX_CMD"):
        command = command or os.environ.get("LAS_CODEX_CMD")
        _exec(bridge_argv("exec", name, _common(["--exec", command], intercept_url, port)))
        return
    # Codex works where you ARE, not at the agent's root: the agent identity
    # comes from the nearest .las-agent.json upward, the working directory is
    # the one you launched from — exactly like running `codex --yolo` by hand.
    raise SystemExit(run_codex_interactive(name, os.getcwd(), codex_args, intercept_url, port))


@click.command("shell")
@_name_arg
@click.option("--yes", is_flag=True, help="Run kind=command messages without asking on the TTY.")
@click.option("--all", "run_all", is_flag=True, help="Offer EVERY message to run, not only kind=command.")
@click.option("--no-widget", is_flag=True, help="Don't bring this agent's widget to the current Space.")
@_intercept
@_port
def shell_cmd(name, yes, run_all, no_widget, intercept_url, port):
    """Connect a plain terminal (no AI) to LAS here: messages print, commands run after a y/N, output goes back to the sender."""
    name = resolve_agent_name(name)
    _chain(name, widget=not no_widget)
    extra = (["--yes"] if yes else []) + (["--all"] if run_all else [])
    _exec(bridge_argv("shell", name, _common(extra, intercept_url, port)))
