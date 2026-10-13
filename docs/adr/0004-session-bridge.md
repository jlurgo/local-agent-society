# ADR 0004 — The session bridge: one mailbox consumer, any runtime

## Status

Accepted (2026-09-27). Phase 1 applied in the same change that introduced this
ADR; phases 2–3 are the plan, not done work.

## Context

Every LAS agent has a broker-owned **mailbox** (vortexia/PROTOCOL.md
"Mailboxes"): a persistent MQTT session that queues each inbound message in
order, survives broker restarts, and hands the backlog to whoever connects
with the agent's client id. Nothing is ever lost between senders and that
mailbox. The problem was the last hop — mailbox → the agent's session.

Until now that hop was `las agent listen` (a paho consumer printing JSON
lines) run under Claude Code's `Monitor` tool by the `/las-agent` skill. The
Monitor caps a watch at 30 minutes, so every half hour, in every session,
the model had to re-arm it: a shell command, a "Monitor started" line, a
"Listener re-armed" line and a recap. A transcript the user pasted on
2026-09-27 showed twenty of those in a row over a weekend of nobody typing.
That is not a product anyone would ship, and it was structural: the noise
came from the tool, not from what the model printed.

Two more requirements arrived with that complaint:

1. The receiving side will not always be Claude. A terminal with no AI in
   it should be able to read messages — which, in a future the user wants
   to keep open, may be literal shell commands rather than dictated natural
   language. Codex or any other coding agent must be pluggable. The system
   has to be multi-platform and multi-AI.
2. A **first-decision layer** is coming: a small local model (in the Pulpo
   project) that hears the mic dictation first and decides — answer
   directly, rewrite, route to Claude, drop — before anything reaches a
   session. It does not exist yet; the architecture must have its slot now.

Claude Code itself gained the primitive that fits: **channels** (research
preview, verified against the docs on 2026-09-27). An MCP server that
declares the `claude/channel` capability may push
`notifications/claude/channel` events into a running session; they arrive
while the session is idle at the prompt or queue into the next turn when it
is busy, in order, with no polling and no cap. The catch: a session started
without the channel flag still runs the server as a plain MCP server and
drops every event silently, with no error back to the server.

## Decision

Replace the Monitor-driven listener with **the bridge** — a single Node
package, `bridge/`, that owns the mailbox → runtime hop for every runtime,
built as a pipeline with one responsibility per stage:

```
MailboxSource ──▶ Pipeline [interceptor, interceptor, …] ──▶ Sink
   (vortexia)      dedup · ignore-kinds · sender policy ·      claude-channel
                   mic self-test · http (first-decision)       shell · exec · stdout
```

- **`MailboxSource`** is THE consumer: fixed client id, persistent session,
  no auto-resubscribe, takeover detection by connection lifetime (a port of
  the rules `las agent listen` had learned the hard way). It acks a QoS 1
  message only after `deliver()` resolved; if delivery rejects it drops the
  connection instead, so the broker redelivers. A sink failing mid-message
  costs a retry, never the message.
- **`Pipeline`** runs ordered interceptors, each returning `continue` or
  `handled`. Adding behavior means adding an interceptor; no source or sink
  changes. The **`http` interceptor** is the first-decision slot: it POSTs
  the envelope to a URL and obeys `{action: handled | continue, envelope?}`.
  It fails *open* — a dead helper must never eat a human's dictation. Pulpo's
  local model plugs in here with `--intercept-url`, and nothing else moves.
- **Sinks** implement `deliver(ctx)` and, optionally, `start()`,
  `waitArmed()`, `stop()`:
  - `ClaudeChannelSink` — the MCP channel server. On initialize it pushes a
    probe event and refuses to be "armed" until the model calls
    `las_channel_ack` with that probe's id. The bridge attaches the mailbox
    only after arming, so a session without the channel flag can never
    become a black hole. It exposes `reply` (to another agent, through the
    backend's inject endpoint — same routing as `las agent send`, relay
    included) and `las_status`.
  - `ShellSink` — a terminal with no AI: prints every message; a
    `kind: "command"` message (or any, with `--all`) is offered to run in the
    agent's folder after a `y` on the TTY (`--yes` skips it), output echoed
    and sent back to the sender.
  - **Interactive TUIs without any API** (Codex's, first): `cli/pty_session.py`
    runs the program inside a PTY that `las` owns and types each mailbox
    message into it as a bracketed paste + Enter — `las codex` is
    `codex --yolo` behind that PTY, fed by a `codex`-tagged `stdout` bridge
    session. One-way by nature (the answer stays on screen); the two-way,
    thread-aware version is Codex's experimental app-server (phase 3).
  - `ExecSink` — runs one configured command per message with the text on
    stdin and `LAS_*` env vars, replies with its stdout. This is the
    multi-AI adapter: `--exec 'codex exec --yolo -'`, an Ollama call, a script.
  - `StdoutSink` — one JSON line per message; what `listen` printed.
- **Status file** `session/bridge-<agent>@<sid>.json` (pid, sink, runtime,
  armed, counters) so `las bridge status` and the skill can ask "is this
  mailbox being delivered right now?" without opening a broker connection.
  One per session (it was one per agent until 2026-10-13): two Claude
  sessions of the same agent clobbered each other's file, and whichever
  exited first deleted the survivor's. `las bridge status` picks the one
  belonging to the calling session by process ancestry.
- **Second Claude account** (2026-10-13): Claude Code keeps one login per
  `CLAUDE_CONFIG_DIR`. `las claudeRelay` = `las claude --account relay`
  sets it to `~/.claude-relay` (symlinking the shared CLAUDE.md, settings,
  skills, hooks from `~/.claude`), registers the channel in that dir's own
  `.claude.json` with `--runtime claudeRelay`, and execs Claude. Any
  `CLAUDE_CONFIG_DIR=~/.claude-NAME` maps to runtime `claudeName`; such a
  runtime inherits the `claude` descriptor (cli/agent_config.py).
  A Team/Enterprise org without `channelsEnabled` makes Claude Code drop
  every channel event (logged only in its MCP log: "channels not enabled
  by org policy"). `las claude*` reads that verdict for the account's own
  session ids and then runs Claude in the `las codex` PTY instead, fed by a
  `stdout` bridge of the same runtime (`--pty` forces it, `--channel`
  retries the channel). Chosen over the retired Monitor + `las agent listen`
  path: Monitor expires at 30 min, bringing back the re-arm turns, and
  depends on the model re-arming it; the PTY needs nothing from the model
  and holds messages while the human types.
- **CLI**: one command per runtime — `las claude [args]`, `las codex [args]`,
  `las shell` — each chaining MCP registration, presence and the widget
  before handing the terminal over (no alias, no separate steps), over the
  low-level `las bridge claude|stdout|shell|exec|status`.
  `las claude` starts Claude Code with
  `--dangerously-load-development-channels server:las` — mandatory while
  channels are a research preview, and the reason the backend's terminal
  launchers now run `las claude` instead of `claude`. `las claude register` (Claude's own scope — the bridge itself is
  runtime-agnostic, and `las claude` registers by itself)
  registers the server once, user-level, in `~/.claude.json`.
- **Skill**: `/las-agent` no longer arms anything. At session start it runs
  `las agent register` and `las bridge status`; it polls only when the
  channel is not armed, and says so in one line. Probe acks are silent.
  Tests in `tests/test_las_agent_skill.py` pin this.

What the user sees per message in a Claude session: one dim inbound line
(`← las · Robotics: …`) and the model's reaction. Nothing every 30 minutes.

## Consequences

- One implementation of the mailbox consumer for every runtime. The Python
  `las agent listen` stays for now (it has its own tests and plain-terminal
  users) and is scheduled for removal once the bridge has run for a while.
- Every Claude session must start through `las claude`. A bare `claude`
  still works, only without live delivery — the skill notices and says so.
- The channel contract is a research preview: the flag is hidden from
  `claude --help` and may change. When channels leave preview this becomes
  `--channels plugin:las@…` or a plugin install; the sink does not change.
- The bridge is Node with `mqtt` and the MCP SDK; it does not need Bun (the
  official channel plugins do). It depends on the sibling `vortexia`
  checkout the same way the widget does (`file:../../vortexia`) — ADR 0003's
  portability work applies to it too.
- `session/bridge-*.json` is runtime state and gitignored.

## Phases

- **Phase 1 (this change)**: bridge package with all four sinks, the
  pipeline and the http slot; `las bridge` / `las claude`; backend launchers;
  skill and docs; tests (Node: source ack semantics with a fake MQTT client,
  the channel protocol end-to-end with the SDK's in-memory client; Python:
  the launchers and the skill contract).
- **Phase 2 (2026-09-28, done)** — *connected sessions*. An agent may have a
  Claude, a Codex and a plain shell attached at once, so every bridge is one
  **session** of its agent (`bridge/src/sessions.js`, backend
  `/agents/{name}/sessions`): it registers with runtime, pid and cwd, touches
  its record on every delivery, unregisters on exit; dead pids are pruned on
  read. Each session has its own inbox
  (`las/agent/<name>/sessions/<sid>/inbox`, persistent client id
  `las-agent-<name>-<sid>`); the agent-level inbox keeps meaning "the agent"
  and is held by the **default** session — the last one used. The backend
  publishes the default's id retained on `las/agent/<name>/default-session`
  and every bridge watches it: whoever becomes the default attaches the
  agent mailbox after a short delay, whoever stops being it releases it — no
  bridge talks to another, no takeover fight. Backend down: the bridge holds
  the agent mailbox alone, as before. Addressing: `las agent send --to Name`
  reaches the default; `--session <sid|runtime>` one session;
  `--all-sessions` every one (the `--children` pattern, across runtimes);
  `las agent sessions [--use X]` lists and switches the default. The widget
  mic has the same choice (press-and-hold the mic, or Settings → "Dictation
  goes to"): last-used session, all, or one — targeted dictations go through
  the backend's `/agents/send`, the default keeps the direct inbox publish.
  Also delivered: `las claude` run *inside* a Claude session (CLAUDECODE is
  set) prints the way back in (`las claude --resume`) instead of nesting,
  and so does `las bridge status` when the session has no channel. Still
  pending from the original phase 2: the widget's unread badge, retiring
  `las agent listen`.
- **Phase 3**: intelligent routing. Pulpo's first-decision service behind
  `--intercept-url` classifies what the mic heard (`kind: "command"` for a
  shell command, `"message"` for prose, or handled outright) and decides the
  target session, so a shell session only ever receives commands and a
  Claude session only prose; the `session`/`all_sessions` routing above is
  the mechanism it drives. `ShellSink` already runs only `kind: "command"`.
