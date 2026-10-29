# Local Agent Society

A coordination layer that turns Claude Code sessions into a **society of named agents** — each living in its own project folder, with a unique voice, a floating widget, and shared infrastructure for ports, TTS, and inter-agent messaging.

Every agent knows the rules. They never talk over each other. They never steal ports. They speak in their own language.

---

## What it does

- **Named agents** — each project directory registers as a named agent (`Wavi`, `Garantido`, `NeuroFlow`…) with its own identity and voice
- **Floating widget** — a macOS tray app shows the agent name on every Space, always on top, with mic input, mute, and config
- **Voice queue** — all TTS goes through a central queue so agents never collide when speaking; each voice has a fixed language
- **Port registry** — agents claim ports before binding; no hardcoded ports, no conflicts
- **Inject** — send a message directly into another agent's live Claude terminal
- **Attribution** — track which agent wrote which file

---

## Requirements

- macOS (arm64; Intel builds untested)
- Python 3.10+ (Homebrew), with `pipx` recommended for the `las` CLI
- Node.js 18+ (Electron widget and the vortexia broker)
- [Claude Code CLI](https://claude.ai/code)
- iTerm2 (agent focus/inject fallbacks use its AppleScript API)
- Network access on first install: `install.sh` clones the sibling
  [vortexia](https://github.com/haciendo/vortexia) repo next to this one and
  downloads the Kokoro TTS model (~340MB); the first mic dictation fetches
  Whisper (~140MB)

> **Status:** this is a developer checkout, not yet a double-click app. Everything
> (launchd jobs, the `las` CLI, the widget `.app`, data and models) lives inside the
> clone. See `docs/adr/0003-standalone-app-distribution.md` for the plan to change that.

---

## Install

```bash
git clone https://github.com/josetabuyo/local-agent-society
cd local-agent-society
./install.sh
```

This builds the Electron widget, installs Python deps, fetches the Kokoro TTS model, clones/updates vortexia next to this repo, registers both launchd jobs, and installs the `las` CLI.

---

## Create your first agent

In any project directory, run:

```
las agent new MyProject
```

The command writes `.las-agent.json`, registers the agent with the backend, assigns a unique voice (with its language), and opens the widget.

---

## The `las` CLI

### System
```
las status                              # backend status, agents, ports
las start / stop                        # start or stop the backend (via launchd: backend/service.sh)
las logs                                # tail backend log
las install                             # run install.sh (compile widget, launchd, CLI)
las uninstall                           # run uninstall.sh (remove the system)
las update                              # run update.sh (git pull + reinstall)
las completion [--shell zsh|bash|fish] [--install]  # set up shell tab completion
las shell-init [--install]    # zsh: tint the terminal background with the agent's widget color on every cd
```

### Agents
```
las agents                              # list all registered agents
las agent new NAME [--voice V] [--dir D]  # write .las-agent.json, register, launch widget
las agent sync                          # sync .las-agent.json → backend
las agent target [T] [--cc/--no-cc]     # where messages/mic land among its sessions: default | all | <runtime> | <sid>
las agent restore [NAME]                # recover .las-agent.json from backend
las agent rename [OLD] NEW [--pronunciation P]  # rename in backend + update .las-agent.json
las agent focus [NAME]                  # bring the agent's iTerm2 window to the front
las agent inject NAME "msg"             # send message to another agent's terminal
las agent inject NAME "msg" --from Me   # with sender label
las agent send --to PARENT --children "msg" [--deep]  # fan out to every subordinate (folder-derived hierarchy)
las agent children [NAME] [--deep]      # list subordinates: agents whose folder sits under this one's
las agent parent [NAME]                 # which agent this one reports to (nearest ancestor folder)
las agents --tree                       # registry rendered as the folder hierarchy
las agent clean [NAME]                  # inject /clear into agent terminal
las agent mute [NAME]                   # silence an agent's TTS
las agent unmute [NAME]                 # re-enable TTS
las agent deactivate [NAME]             # mark inactive, close its widget (session untouched)
las agent activate [NAME]               # mark active again
las agent wake-enable [NAME]            # allow `las agent focus` to wake it from inactive via vortexia
las agent wake-disable [NAME]           # disallow the auto-wake fallback above
las agent delete [NAME] [--yes]         # unregister from backend
las agents --inactive                   # list only inactive (put-away) agents
las agents --active                     # list only active agents
las widget [NAME]                       # reopen one agent's floating widget (new position, keeps color/prefs)
las widgets                             # reopen every registered agent's widget
las widget [NAME] --reload              # re-run one widget's face from the checkout (no rebuild, no restart)
las widgets --reload [--force]          # same for every open widget; waits for an in-flight dictation unless --force
las link [--agent NAME] [--tty PATH]    # link the current (or given) terminal to a widget
```
`NAME` is optional on most `agent` subcommands — it defaults to the agent registered for the current directory (via `.las-agent.json` or a path match in the backend registry).

`las agent focus` also acts as the wake-up path: if an agent has no live terminal session, is marked inactive, and has `wake-enable`d, it opens a new iTerm2 window running `las claude` in the agent's directory and marks it active again — instead of just reporting "not found". No permission flag is forced: the session uses your own Claude settings (e.g. auto mode); pass flags by hand with `las claude [args]`.

### Voices
```
las voices list                         # all voices with language flag
las voices info Samantha                # language info for one voice
las voices random                       # pick a random unused voice
```

### Ports
```
las ports ls                            # view port registry
las ports free [--start N] [--end N]    # get a free port number (default range 9000-9999)
las ports claim APP [--port N]          # atomically claim and register a port
las ports release PORT                  # release a registered port
las ports audit                         # cross-check registry against `lsof` — finds ghosts + unregistered listeners
```

### TTS Queue
```
las speak "Hello"                       # enqueue TTS (uses agent voice + name from .las-agent.json)
las queue ls                            # show pending items
las queue clear                         # clear all pending messages
```

### Other
```
las boarding                            # print path to the onboarding page
las boarding --open                     # open in browser
```

---

## Society rules

Agents share resources and follow a civility contract:

1. **Voice queue** — always via `POST /queue/speak` or `las speak`, never `say` directly; the queue prevents collisions
2. **Voice language** — each TTS voice has a fixed language; English voices speak English text, Spanish voices speak Spanish text — never mix them
3. **Ports** — always reserved via `las ports claim` or `POST /ports/claim` before starting any server
4. **Voices** — unique per agent; declared in `.las-agent.json` with a `locale` field (e.g. `en-US`, `es-MX`)
5. **Messages** — sent via `las agent send --to NAME "msg"` (or `inject`, or `POST /agents/{name}/inject`), delivered over **vortexia** into the recipient's broker-owned mailbox, and from there into the recipient's session by the **bridge** (`bridge/`, docs/adr/0004): live into a Claude Code session through the LAS channel (`las claude`), into a plain terminal (`las bridge shell`), into any other runtime (`las bridge exec --exec CMD`), or on demand (`las agent poll`).
6. **Response language** — agents respond in the language of their TTS voice (`locale` field in `.las-agent.json`)

---

## Backend API

Runs at `http://localhost:8700` · Docs at `http://localhost:8700/docs`

Endpoints below are cross-checked against `app.openapi()['paths']` in `backend/main.py` — this table lists exactly what's live, nothing aspirational.

| Endpoint | Description |
|---|---|
| `GET /health` | Backend liveness check |
| `GET /agents` | All registered agents |
| `POST /agents` | Register / update an agent |
| `DELETE /agents/{name}` | Unregister an agent |
| `PATCH /agents/{name}` | Rename an agent (`{new_name, pronunciation?}`) |
| `POST /agents/{name}/focus` | Bring the agent's iTerm2 window to the front |
| `POST /agents/{name}/terminal` | Open a new iTerm2 window running `claude` in the agent's directory |
| `GET /agents/{name}/ttys` | List TTYs known to be associated with the agent |
| `POST /agents/{name}/inject` | Publish a message to the agent's vortexia inbox (`las/agent/{name}/inbox`) |
| `POST /agents/{name}/vortexia/register` | Publish a retained "online" presence payload for the agent on vortexia |
| `GET /agents/{name}/vortexia/poll` | Drain the agent's vortexia inbox for up to `timeout` seconds and return what arrived |
| `POST /agents/{name}/mute` | Mute agent TTS |
| `DELETE /agents/{name}/mute` | Unmute agent TTS |
| `GET /agents/{name}/muted` | Check whether an agent is muted |
| `POST /agents/{name}/pin-tty` | Store a TTY linked via `las link` for the widget to pick up |
| `GET /agents/{name}/pending-link` | Return and clear the pending linked TTY (consumed once) |
| `GET /widget/{name}` | HTML page rendering the floating widget for an agent |
| `GET /debug/iterm_ttys` | List all TTYs currently known to iTerm2 via AppleScript |
| `GET /voices` | All voices with `{name, lang, flag}` |
| `GET /voices/{name}` | Language info for one voice |
| `GET /voices/random` | Random unused voice name |
| `GET /ports` | Port registry |
| `POST /ports` | Register a port directly (no availability check) |
| `DELETE /ports/{port}` | Release a port |
| `GET /ports/free` | Get a free port number (`?start=&end=`, default 9000-9999) |
| `POST /ports/claim` | Atomically claim + register a port |
| `POST /queue/speak` | Enqueue TTS `{text, voice, name}` |
| `GET /queue` | Current queue |
| `DELETE /queue` | Clear queue |
| `POST /queue/ack` | Widget → backend: `{id, phase: started\|done\|skipped, reason?}` — the drainer holds the next clip until the current one is reported over |
| `POST /attribution` | Record a file attribution entry |
| `GET /attribution` | File attribution log (`?file=` or `?name=`) |

Interactive docs (Swagger UI) are always available live at `http://localhost:8700/docs`.

A TypeScript SDK is available at `sdk/society.ts`.

---

## Opening a session — one command per runtime

Every runtime that should hear this agent's messages is opened with one `las`
command from its own terminal, in the agent's folder. Each one chains what
the session needs — the `las` MCP server registered in `~/.claude.json`,
presence published, the widget brought to the current Space — and then hands
the terminal over. No alias, no `las widget`, no separate register step.

| Command | What listens | What a message becomes |
|---|---|---|
| `las claude [args]` | Claude Code with the LAS channel (`bridge/`, ADR 0004) | a `<channel source="las">` event the model acts on, idle or mid-turn |
| `las codex [args]` | Codex's own TUI (`codex --yolo`) inside a PTY `las` owns | typed into Codex as a paste + Enter, tagged `[LAS message from …]`; `--exec` switches to headless `codex exec` runs whose answers go back to the sender |
| `las shell [--yes] [--all]` | a terminal with no AI | printed; `kind: "command"` ones run after a `y/N`, output goes back |

A bare `claude` still works, only without live delivery: messages wait in the
mailbox and the `/las-agent` skill says so in one line. `las bridge status`
tells whether the current session is armed; `las bridge <sink>` is the
low-level form behind all three.

Several runtimes can be attached to the same agent at once — each one is a
**session** (`las agent sessions`), the agent's *children*. The last one used
is the default: a plain `las agent send --to NAME` reaches it, `--session
claude|codex|shell|<id>` picks one, `--all-sessions` reaches every one, `las
agent sessions --use X` switches the default by hand. The agent itself can
pin where unqualified messages (and the widget mic) land — `las agent target
shell|all|default|<id>`, written to its `.las-agent.json` as `sessions.target`
— and ask for a for-the-record copy to its last-used session whenever a
message went elsewhere (`--cc` on one send, `las agent target --cc` for all):
the shell runs the command (a shell is handed everything as a `command`, so
choosing it means "run what I say"; `--command` marks one explicitly for an
intelligent session), the Claude session knows it happened. The widget's
👥 children button offers the same list (click or hold), and Settings →
"Dictation goes to". See `docs/adr/0005-nested-mailboxes.md`. Already inside
a session that was opened without `las`? `las claude` (or `las bridge
status`) prints the way back in: `las claude --resume` restores the
conversation with the channel on, and the mailbox kept every message
meanwhile.

## Widget buttons

Each widget (Electron, `widget-electron/`) has a name/log face with a door
button top-right, and a row of face buttons at the bottom:

| Button | Action |
|---|---|
| 🚪 Door (top-right, next to the name) | Deactivate: mark inactive, close this widget (session untouched) — see `las agent deactivate` |
| ⚙ Gear | Toggle settings mode inline (name/log stay visible above it; every other face button hides; gear shows "pressed" while open) |
| 🧹 Clear | Type `/clear` into the linked terminal(s) |
| ⧉ Open | Open a new terminal window (or the folder) at the agent's path — click runs the default, hold/right-click picks and reorders |
| 🔊 Speaker | Toggle mute |
| 🎙 Mic | Toggle dictation (click to start/stop; local Whisper transcription) |
| 👥 Children | Which connected session (Claude, Codex, shell) the mic talks to — click, hold or right-click to pick one, all, or the last used, plus a "copy last-used session" toggle; the choice is the agent's own (`sessions.target` in `.las-agent.json`, same as `las agent target`) |

## Open button

The ⧉ button (it replaced the command palette) has two actions, both anchored
on the agent's registered directory — the folder holding its
`.las-agent.json`, as the backend registry reports it:

- **Terminal** — a *new window* of the default terminal with its shell started
  in that folder. On macOS the widget prefers Ghostty (via its scripting
  dictionary, so it's a window, not a tab in whatever you were typing in), then
  iTerm2, then Terminal.app; `LAS_TERMINAL_APP` overrides that. The window
  lands on the Space you pressed the button from.
- **Folder** — that folder in Finder.

A plain click runs the **default** (the top one). Press-and-hold or
right-click shows both, in order: click a row to run it, ▲/▼ to reorder. The
order persists per agent (`openOrder` pref); out of the box it's Terminal,
then Folder.

## Widget settings

Click the ⚙ gear button to open **settings** — inline, not a separate
screen; the widget's own name/log stay visible above it:

- **Color** / **Opacity** — the opacity slider only fades the fill of the
  background, name text, and face-button circles; each one's outline
  (the name's letter stroke, each button's border) stays crisp/opaque
  regardless, so the widget stays readable even very transparent.
- **Always on top**
- **Mute**
- **Speech bubbles** (on by default) — what this agent says out loud also
  pops up as a bubble at the screen edge when its widget is on another
  Space; see **Speech bubbles** below.
- **Expand when hidden** (on by default) — while occluded/off-Space, the
  widget balloons to a big, click-through, full-screen name banner instead
  of just disappearing; shrinks back once its Space is on screen again (see
  **Shrink delay** below).
  When several widgets share the same macOS Space, they tile that Space's
  screen as a mosaic (halves for 2, one of five layouts for 3, a 2-column
  grid for 4+) instead of overlapping — grouped per `(display, Space)`, not
  just per physical display, so unrelated agents on other Spaces are never
  pulled into the same grid.
- **Wake up via vortexia** — lets `las agent focus` wake this agent from
  inactive (see the CLI table above) instead of reporting "not found".
- **Dictation language**
- **All widgets → Shrink delay (ms)** (300 by default) — how long a grown
  widget stays big after you switch back to its Space before it shrinks.
  Lower is snappier; raise it if it shrinks mid-animation.
- **All widgets → Heartbeat (ms)** (500 by default) — how often every widget
  checks which Space it is on. The shrink lands within one heartbeat plus the
  shrink delay. These two are shared by every widget of the running app, not
  per agent: change them in any widget's panel and all panels follow.

The agent's name auto-fits its box: it shrinks to the widest size that still
fits on one line, and if it still doesn't fit, breaks at whichever generic
title boundary (a space, a hyphen, or a lowercase→Uppercase transition)
falls closest to the middle — same rule in both the compact face and the
expanded/mosaic banner, just with a much bigger target size in the latter.

## Speech bubbles

When an agent speaks (the short spoken summary of its results, `las speak`)
and its widget is on a Space other than the one you are looking at, a
bubble in the agent's color slides in at the edge of the screen on the side
that Space lies — left if the agent's Space is to the left of the current
one in Mission Control order, right otherwise. Bubbles pile up from the
bottom corner of that side (newest at the bottom, older ones pushed up, one
pile per side), never take focus when they appear, and go away on their own
after 20 s unless the pointer is over one or a text answer is open.

- **Click the text** → macOS switches to that agent's Space (its widget is
  focused).
- **🎤 Voice** → same, and the widget starts a dictation as if its mic
  button had been clicked (the mic button stops it).
- **⌨ Text** → an input in the bubble; Enter sends. The answer takes the
  exact path of a dictation (from the agent, to the agent, source human),
  so the agent's `sessions.target` decides which session gets it.
- **✕** or Esc → dismiss.

No bubble when the agent is on the current Space (its face already shows
the text), and none at all for an agent whose **Speech bubbles** setting is
off. Direction comes from a private macOS call (`lib/spaces.js`); if it is
ever unavailable, bubbles still appear, on the right.

## Editing the widget

The running app is the packaged build in `widget-electron/dist/`, but its
face is not frozen in there: the renderer (`widget-electron/renderer/`) and
`preload.js` are loaded from the checkout whenever the app finds one (it
walks up from its own location to `start.sh` + `backend/main.py`). So:

- **renderer / CSS / HTML / preload change** → `las widgets --reload` (or the
  tray's *Reload widgets*, or `open 'localagentsociety://?action=reload'`).
  Every open widget re-runs its face in place; a grown (mosaic) face and a
  held mic are pushed back to it. A widget whose mic is recording is skipped
  and the CLI waits for an idle mic before asking at all. The on-face message
  log is cleared by the reload.
- **`main.js` / `tray.js` / `lib/` change** → `npm run build` in
  `widget-electron/`, then `./restart-widget.sh`: that is the running
  process itself.

Tests: `npm test` in `widget-electron/` (node's built-in runner).

---

## Skills (Claude Code)

| Skill | What it does |
|---|---|
| `/local-agent-voice` | Change the agent's TTS voice (updates locale too) |
| `/local-agent-pronunciation` | Set a phonetic hint for TTS |
| `/local-agent-widget` | Reopen the floating widget |

---

## Project layout

```
backend/        FastAPI backend (port 8700)
cli/            `las` CLI (Click)
docs/           boarding.html — full onboarding reference
sdk/            TypeScript client
skills/         Claude Code skills
tests/          Test suite (pytest)
widget-electron/  Cross-platform floating widget (Electron)
```

---

## License

MIT
