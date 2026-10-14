---
name: las-agent
description: Integration with the Local Agent Society's "las" CLI — read .las-agent.json, use TTS via `las speak`, manage ports, and carry the full context of the society (who the other agents are, what they run, known issues, and how a local agent is expected to behave).
allowed-tools: Bash(las:*) Bash(cat:*)
---

# /las-agent — Local Agent Society integration

Load this skill at the start of a session to enable TTS, local-agent config reading, port safety, and inter-agent messaging via the `las` CLI.

---

## 0. What this is and why it exists

Local Agent Society exists because two problems kept breaking multi-agent work on the same machine:

1. **Port collisions.** Several Claude Code sessions, each working on its own web project, would grab the same dev-server port as another session already using it — a constant, avoidable fight over shared resources.
2. **Overlapping voices.** Every session used the same TTS voice, so when two or more terminals spoke at once, the audio overlapped and none of it was intelligible. On top of that, a voice built for one language sounds wrong reading another — an English voice reading Spanish (or vice versa) is not just accented, it's unusable.

The society's rules — a port registry, a speech queue, one voice per agent, voice language matched to text language — exist to fix exactly those two problems. See the project `CLAUDE.md` for the full civility contract; this skill is about how a local agent actually behaves session to session.

From there the **widget** emerged, and with it a shift in what this project actually is. What runs day to day isn't just a CLI: it's a business/context manager. The widget's label is a signpost — when you sit down at a different desktop or a different computer, it reminds you what you're working on there, because that desktop already has its own open tools, tabs, and a session specialized in a given piece of work.

Every agent has its own scope — whatever business it's actually working on in its own directory (see the Scope Ladder, §5, for how to state it). This document is the shared "how a member of the society behaves" — it deliberately says nothing about any one agent's particular scope. A small number of agents happen to have the society's own tooling *as* their scope (an agent working from `local-agent-society/` or from the sibling `vortexia/` repo, say) — that's a special case specific to those agents, not something every local agent shares, and it belongs in that agent's own local, repo-specific skill, not here.

---

## 1. What it means to be a local agent

If a session starts in a directory with a `.las-agent.json`, it is a member of this society, not a standalone Claude Code session. That means, concretely:

- You have one **name**, one **voice**, and a **locale** — never borrow another agent's.
- You **speak** through the queue (`las speak`), never `say` directly, and you **hear** other agents through vortexia, not through the terminal.
- You know your own **scope** and can state it at whatever level of detail is asked (see the Scope Ladder, §5) — no other agent, and no future router, should have to guess what you're for.
- You know **how to reach any other agent**, whether it's on this Mac or another one, without reinventing a mechanism that already exists (see §4 — this has burned agents before: don't assume something is missing just because you haven't used it yet).
- You act on what you hear. See §7 — waiting for explicit human permission before responding to another agent defeats the point of a society that talks to itself.

The rest of this document is the concrete "how."

---

## 2. Starting a session

### Check for a local agent config

```bash
cat .las-agent.json 2>/dev/null
```

- **If it exists:** read `name`, `voice`, and `locale`. Every TTS announcement this session makes must go through:
  ```bash
  las speak "<text>" --name <agent_name>
  ```
  Never call the HTTP queue directly (`POST /queue/speak`). Only the top-level model (the protagonist) speaks — Haiku/Opus subagents stay silent.
- **If it doesn't exist:** no LAS integration this session. Standard behavior.

### Presence and live delivery (vortexia → this session)

**How a session is opened decides everything.** One `las` command per runtime, run from that runtime's own terminal, in the agent's folder — it chains what the session needs (the `las` MCP server registered, presence published, the widget brought to this Space) and then hands the terminal over:

```bash
las claude [claude args]   # Claude Code with the LAS channel — THIS session, if it was opened right
las claudeRelay [args]     # the same, on the second Claude login (~/.claude-relay) — runtime claudeRelay
las codex [codex args]     # Codex's own TUI (`codex --yolo`) in a PTY; every mailbox message is typed into it
las shell [--yes] [--all]  # a terminal with no AI: messages print, kind=command ones run after y/N
```

Nothing else to type — no `las widget`, no `las agent register`, no alias. `las claudeRelay` is `las claude --account relay`: Claude Code keeps one login per `CLAUDE_CONFIG_DIR`, so a second account (a company email) lives in `~/.claude-relay` (created on first use, CLAUDE.md/settings/skills/hooks symlinked from `~/.claude`; first run: `/login`). Any `--account NAME` works the same way → `~/.claude-NAME`, runtime `claudeName`. Both Claudes are separate sessions of the same agent — own sid, own mailbox, own status file — so one agent folder can hold `claude`, `claudeRelay`, `codex` and `shell` at once. Be the expert here: when the human asks how to "connect" a terminal, an agent, Codex, a shell, the answer is one of those three commands; never a pile of setup steps.

When this skill loads, run exactly one check:

```bash
las bridge status             # is this session's LAS channel armed? exit 0 = yes
```

Messages reach this session over the **LAS channel**: a Claude Code *channel* (an MCP server, `bridge/` in the local-agent-society repo, that Claude Code itself starts from `~/.claude.json` — registered by `las claude` itself, repairable with `las claude register`). It holds the agent's vortexia mailbox and pushes every message into the session the instant it arrives, whether the session is idle at the prompt or busy (then it's queued into the next turn, in order). There is no Monitor, no polling loop and no re-arming: a message shows up in context as

```
<channel source="las" sender="Robotics" origin="agent" kind="message" msg_id="..." ts="...">text</channel>
```

Treat it exactly as if the human had typed it (§7): act, then report as usual. `origin` is who spoke — `human` (the widget mic), `agent`, or `system`. Answer another agent with the channel's `reply` tool (`to` = the `sender` attribute) or `las agent send`.

**When the account's org blocks channels — messages arrive typed.** A Team/Enterprise login whose admin hasn't enabled Claude Code channels drops every channel event (Claude's MCP log says `channels not enabled by org policy`). `las claude`/`las claudeRelay` detect that from Claude's own log and start Claude inside a PTY instead, like `las codex` (`--pty` forces it, `--channel` retries the channel). Messages then arrive as prompt text you seem to have typed: `[LAS message from <sender>] <text>` (`from mic` = the human's dictation). Treat each one exactly like a channel event: act, and answer an agent with `las agent send --to <sender> "..." --from <AgentName>`. A `[las-session-title]` or mic self-test text inside one is the same housekeeping as always. In that mode `las bridge status` reports the `stdout` bridge as armed — that is correct, there is no probe to ack — and you never arm a Monitor.

**Arming — the probe.** Right after it connects, the channel pushes one probe event (`kind="probe"`, text starting with `[las-channel-probe]`). Call the `las_channel_ack` tool with its `probe_id` immediately and say nothing about it. That single round trip proves the path end-to-end, and only then does the bridge attach the mailbox — before that nothing is consumed, because a session started without the channel flag would otherwise swallow messages silently (Claude Code drops channel events it wasn't told to accept, with no error). The probe is a liveness check, not a message: no report, no TTS, no comment — the same rule as the mic self-test.

**Several runtimes at once = sessions, the agent's children.** The same agent can have a Claude, a Codex and a shell attached; each is a *session* (`las agent sessions`), the last one used is the **default** — a plain `send --to Name` reaches it, its bridge holds the agent mailbox. Pick one with `--session claude|claudeRelay|codex|shell|<id>`, all with `--all-sessions`, switch the default with `las agent sessions --use X`. The recipient itself can pin where unqualified messages and its widget mic land: `las agent target default|all|<runtime>|<sid>` writes `sessions.target` into its `.las-agent.json`; `--cc` (on a send, or `las agent target --cc` for good) hands the last-used session a for-the-record copy of whatever went to another child (docs/adr/0005). A message that arrives here may carry `session="<id>"` in the tag: it was aimed at this session specifically. One with `kind="cc"` is such a copy — something the human sent to this agent's shell or Codex: take note, do not act on it, do not reply, no closing report. The widget's 👥 children button (click or hold) offers the same list as `las agent target`.

**Session titles — say what this terminal is working on.** Each session can carry a short title, shown next to its runtime (`claude`, `codex`, `shell`) in the widget's 👥 children list and in `las agent sessions`. It is rung 0 of the scope ladder (§9) one level down: about 34 characters, a soft target, never truncated, in the agent's language — e.g. `las agent title "Widget session titles"`. The command finds its own session by process ancestry; `--session <sid>` names one explicitly. Two moments to set it:

- **At the start of real work** — once the first task of the session is clear (not on a bare probe or greeting), set the title yourself, silently. Update it when the work clearly changes direction.
- **When asked** — the widget's "↻ Refresh descriptions" button sends every intelligent session an event with `kind="title-request"` whose text starts with `[las-session-title]` and carries the exact command to run (with `--name` and `--session` filled in). Run that command with a fitting title and do nothing else: no reply, no TTS, no closing report — a housekeeping turn, like the probe. A shell never gets one (it cannot describe itself). Codex gets the same text typed into its TUI and answers by running the same command.

**If `las bridge status` exits non-zero**, the channel isn't armed in this session — almost always because Claude was started as bare `claude` instead of `las claude` (the wrapper adds `--dangerously-load-development-channels server:las`, mandatory while channels are a research preview, and it is also what registers the `las` MCP server and publishes presence). Then, and only then, do the chain's work by hand, drain once, and tell the user in one line that live delivery isn't active this session and how to get it for THIS conversation: exit and `las claude --resume` (`las claudeRelay --resume` on the second account; Claude restores the conversation; the mailbox keeps every message meanwhile — `las bridge status` prints the same guide):

```bash
las agent register            # presence — `las claude` would have done this
las agent poll --timeout 2    # prints anything queued; the mailbox keeps everything until a consumer arms
```

**Never start `las agent listen` under a Monitor anymore.** That was the previous delivery path, and its 30-minute re-arm turns — a shell command, a "Monitor started", a "Listener re-armed" and a recap, every half hour, in every session — are exactly the noise the channel removes. `las agent listen` / `las bridge stdout` still exist for plain terminals and scripts; `las bridge shell` for a terminal with no AI in it; `las codex --exec CMD` / `las bridge exec` for a headless runtime (one run per message, answer sent back). None of them is for a Claude session.

### Mic self-test ping — reply "OK" immediately

Double-clicking the widget's mic (`runMicSelfTest()` in `widget-electron/renderer/widget.js`) doesn't just confirm the microphone captures audio (the 👍) — it also publishes into this agent's own vortexia inbox, the same path as a real dictation, an exact sentinel message:

```
[las-mic-selftest] reply with just "OK" to confirm this session is listening.
```

If a received message (a channel event, or a `poll` line) is exactly that text: **reply immediately by speaking only "OK"** (`las speak "OK" --name <AgentName>`) and do nothing else — it's not a real request, don't trigger any other action, don't treat it as a task. The point is explicitly end-to-end: the self-test used to speak a hardcoded "OK" from the Electron process without ever involving a real session — giving false confidence even with no console attached. Now, if nobody answers, that silence IS the useful signal: it means no live session is listening for that agent, exactly the gap the old self-test used to paper over.

### Messages that look cut off — ask, don't declare the pipe broken

**Verified in code (2026-09-09): there is no length limit anywhere in the chain** — the bridge pushes the envelope's full text, the backend doesn't truncate, and vortexia's clients publish the string as-is. A channel event carries the whole message. If a message genuinely looks incomplete or ambiguous (ends mid-sentence, no closing punctuation), that doubt is legitimate, but the right response is to ask the user if something's missing or to resend the last part — **never refuse or pause a task by arguing "the message got cut off" as if it were a system bug**. It isn't.

### TTS language — must match the voice

The TTS engine only sounds natural when the text is in the voice's own language. **Never mix languages.**

| Voices | Text language |
|---|---|
| Samantha, Daniel, Moira, Karen, Tessa, Rishi, Flo, Sandy, Shelley, Reed, Eddy, Zoe, Nicky, Evan (and `en-*` variants) | **English** |
| Paulina, Mónica (and `es-*` variants) | **Spanish** |

**How to determine the session's language:**

1. If `.las-agent.json` has `"locale"`: use that locale (`en-*` → English, `es-*` → Spanish).
2. If there's no locale, derive it from `voice` using the table above.
3. Default if neither is available: **English**.

**Which voice actually sounds.** Synthesis is Kokoro (backend), not macOS `say`: the `voice` name above only decides the *language*; the widget then hashes the agent's name into that language's Kokoro pool (`widget-electron/lib/kokoroVoices.js`), so the gender is whatever the hash lands on. To pin one explicitly — e.g. a masculine Spanish voice — set `"tts_voice": "em_alex"` (any id from that pool: `ef_dora`/`em_alex`/`em_santa` for Spanish, `af_*`/`am_*`/`bf_*`/`bm_*` for English) in `.las-agent.json` and `las agent sync`; an unknown id warns and falls back to the hash.

**Golden rule:** whatever text you pass to `las speak` must always be in the language that matches the agent's voice. If the voice is Samantha, speak English. If it's Paulina, speak Spanish. Even if the user writes to you in another language, the TTS goes out in the voice's language.

### Closing report — brief summary at the end of every turn (mandatory)

There is no longer a global `Stop` hook (`~/.claude/hooks/announce-here.sh`) announcing a generic "Here! `<Name>`" with no real content — it was removed from `~/.claude/settings.json`. That responsibility now belongs to this session: **before handing control back to the user, speak a brief summary of what just happened.** This is what leaves a useful record in the widget's message history of what the agent was actually doing — not just "it's alive," but "it did this."

**Format (a template with a slot, not fixed text):**

```
"<report verb>: <summary>. <AgentName>."
```

- `<report verb>` is `"Reporting"` in English / `"Reportando"` in Spanish, matching the voice's language (see table above).
- `<summary>` is what just happened, in the voice's language, kept within `response_length_hint` characters (one sentence at the default 40; more when the agent asks for a longer hint).
  - Read `response_length_hint` from `.las-agent.json` (older files call it `report_max_chars`; `las update` renames it via `scripts/migrate-agent-json.py`). **If neither exists, default to 40.** It is a soft target, never a truncation: an agent that sets it high (e.g. 280) wants fuller spoken reports — give two or three sentences, not one clipped line.
  - **Hard fallback** (never leave the slot empty): if there's nothing substantial to summarize — a pure chat turn, a question with no action, etc. — use `"done"` (English) / `"listo"` (Spanish) as `<summary>`.
  - **Not on housekeeping turns.** A turn that exists only because a background notification arrived — a background task finished, a channel probe — with no human message and nothing done for the human gets no closing report and no TTS at all. The `"done"`/`"listo"` fallback is for turns the human started; speaking "Reporting: done" on a probe or a task notification is exactly the noise this rule exists to prevent.
- `<AgentName>` is the `name` from `.las-agent.json`.

```bash
# English, Samantha voice, response_length_hint: 40
las speak "Reporting: widget chat bubbles done. LocalAgentSociety." --name LocalAgentSociety

# Spanish, Paulina voice
las speak "Reportando: base de datos migrada. Robotics." --name Robotics
```

---

## 3. No session artifacts — ever

Never create any of the following, no matter how complex the task:
- `session/`, `inbox/`, `outbox/` folders
- Log files, `.txt` or other files for inter-agent communication
- State files to track conversation progress

All inter-agent communication happens over vortexia — in-memory, per message — never on disk.

---

## 4. Cross-machine messaging already exists — don't rebuild it

This has already tripped up more than one agent (an agent once reported "no way to reach an agent on another Mac" as a gap needing a design) — it's not a gap. Read this section before concluding otherwise.

Two Macs can already talk directly, agent to agent, over **vortex-relay** (part of the sibling `vortexia` project — see `vortexia/docs/vortex-relay-poc.md` and `vortexia/docs/architecture.en.html`):

```bash
# Reach a specific agent on a specific machine
las agent send --to "System@uy-mac" "message here"

# Local delivery still works the same way, with or without an env suffix
las agent send --to System "message here"
```

Under the hood, each Mac runs its own local vortexia broker, and vortex-relay bridges environments by whichever transport is cheapest/available, cost order:
1. **Local** — same machine (what `inject`/`send` always did).
2. **Direct LAN** — mDNS-discovered peer on the same network, a live MQTT connection straight into the peer's broker. This is what you want on the same Wi-Fi/LAN.
3. **Relay** — Nostr (preferred: free, self-issued keypair, no shared rate limit) or Gist, store-and-forward, for when there's no direct path (different networks, one machine asleep, etc.). Falls back automatically; no code needs to know which one carried a given message.

**What each machine needs configured** (in `vortexia/vortexia.env`, gitignored):
```
VORTEXIA_ENV_NAME=<this machine's unique name>
VORTEXIA_RELAY_ENV_NAMES=<comma-separated list of every machine's env name>
VORTEXIA_NOSTR_SECRET_KEY=<this machine's own hex secret key>
VORTEXIA_NOSTR_PEERS=<envName>:<their pubkey hex>,<envName2>:<their pubkey hex>
```
Pairing is mutual: each side needs the other's pubkey in its own `VORTEXIA_NOSTR_PEERS` before Nostr trusts both directions. If a peer's env isn't configured yet, that's the actual missing piece — not the mechanism itself.

If a message to a cross-machine target fails right after a broker restart with "no agent named X is known across vortex-relay," that's very likely a race: directory sync runs on a timer (every ~15s) and hasn't completed its first pass yet — retry once rather than concluding the peer isn't reachable.

---

## 5. Port safety (before starting any server)

Always run these steps before starting any HTTP server or service:

```bash
# 1. Check for conflicts
las ports audit

# 2. Get a free port
las ports free

# 3. Claim it
las ports claim "<description>" --port <PORT>
```

Never hardcode a port that isn't in the LAS registry. If a port is already held by another LAS agent, inject a message and wait:

```bash
las agent inject <OtherAgent> "Port <PORT> is needed — can you release it?" --from <ThisAgent>
```

---

## 6. The society — who we are

> **KEEP THIS UPDATED:** this table lives in the `local-agent-society` repo. Whenever an agent is added, removed, or changed, update it here too.

| Agent | Voice | Path | Stack | Ports |
|--------|-----|------|-------|---------|
| LocalAgentSociety | Samantha (EN) | `local-agent-society` | — | 8700 |
| Garantido | Daniel (EN) | `Garantido` | Next.js 16 + Turbopack | 8765, 8010, 9001 |
| NeuroFlow | Moira (EN) | `NeuroFlow` | Vite frontend | 5181, 8510 |
| Forti | Mónica (ES) | `Forti` | — | — |
| Pulpo | Tessa (EN) | `pulpo` | Vite frontend + Python backend | 5173, 8000, 9004 |
| HomeControl | Shelley (EN) | `home-control` | — | — |
| Wavi | Flo (EN) | `wavi` | Chrome headless (WhatsApp automation) | 9200–9233 |
| Minis App Acces | Sandy (EN) | `Ctrol_Acc_Mv2026` | — | — |
| System | Reed (EN) | `System` | Infrastructure monitor | — |
| Teli | Rishi (EN) | `teli` | Telegram automation | — |
| Robotics | Paulina (ES) | `Robotics` | — | — |
| LocalModels | Eddy (EN) | `local-models` | Ollama + gemma4:e4b, API :11434 | 9002 |
| Luganense | Jorge (ES) | `Luganense` | Next.js | 9003 |
| Vortexia | Sandy (EN) | `vortexia` | Local MQTT broker + vortex-relay | 9012, 9014 |

This table only lists this machine's agents. Other machines (e.g. `uy-mac`) run their own society with their own roster — reach them by name via §4, not by expecting them to appear in this table.

### Inter-agent communication (same machine, via vortexia)

Messaging between agents runs over **vortexia** (local MQTT broker, sibling project — see `vortexia/PROTOCOL.md`), never terminal injection. `las agent inject`/`send` publish to the recipient's vortexia inbox; nothing gets typed into anyone's terminal.

```bash
# Send a message to another agent's vortexia inbox (local or cross-machine — see §4)
las agent send --to <AgentName> "<message>" --from <ThisAgent>

# Is my mailbox being delivered live into this session? (exit 0 = channel armed)
las bridge status [<MyName>]

# Which runtimes are attached to an agent right now (a Claude, a Codex, a shell), which is the default
las agent sessions [<Name>] [--use <id|runtime>] [--refresh]
las agent sessions --all                                         # society map: every agent's terminals + titles
las agent title "<what this session is working on>"             # ~34 chars; shown in the widget's children list
las agent target [default|all|<runtime>|<sid>] [--cc/--no-cc]   # where messages + the mic land among MY sessions (.las-agent.json)
las agent send --to <Name> --session shell --cc "make test"     # the shell runs it (a shell is handed everything as a command), the last-used session gets a cc
las agent send --to <Name> --command "make test"                # mark it a command for an intelligent session
las agent send --to <Name> --session shell "ls -la"     # one session
las agent send --to <Name> --all-sessions "heads up"     # every session

# Drain my own vortexia inbox by hand (fallback only — the channel does this live)
las agent poll [<MyName>] --timeout 2

# Deliver my mailbox somewhere that is NOT a Claude session
las bridge shell [<MyName>]                 # a plain terminal: print, run kind=command after y/N
las bridge exec [<MyName>] --exec "CMD"     # Codex / a local model / any tool, text on stdin
las bridge stdout [<MyName>]                # one JSON line per message

# Announce online presence on vortexia (already done at skill startup)
las agent register [<MyName>]

# Speak via TTS as this agent
las speak "<text in the voice's language>" --name <AgentName>

# Bring another agent's window to the front
las agent focus <AgentName>

# Full status of the society
las status
```

**Sending to the right terminal — a habit, not an exception.** Agents have several terminals open (a Claude, a Codex, a shell), each with a title saying what it is working on. Keep a map of the society in mind and aim:

1. **Know the map.** `las agent sessions --all` returns every agent's open sessions with runtime, title and whether it is intelligent — one local call. Keep the result in your context as a cache; refresh it when it is older than ~30 min, before a send that matters, or when a send says the picture changed. Don't re-run it before every message.
2. **Choose.** Recipient with one session, or a message not about any particular terminal → a plain `las agent send --to X` (the recipient's own choice, `sessions.target`, decides — by default its last-used session). Recipient with several sessions and a message about one line of work → the session whose title matches: `--session <sid>` (or `--session <runtime>` when any of that kind will do). Never prose to a shell — it only runs commands.
3. **Unclear?** If titles are empty or don't tell you which terminal does what, `las agent sessions X --refresh` asks X's sessions to title themselves, waits, and shows the answer; then send.
4. **Learn from the answer.** A plain send to an agent with several sessions prints them (`X has 3 sessions — next time pick one with --session`). Update your map with it.

**Answering as the recipient.** When a message reached you without naming a session and your agent has more than one open, first give the useful answer; then, in the same reply, add one line listing your other sessions (runtime + title, from `las agent sessions`) so the sender can decide whether to keep talking to you here or address the terminal that owns that work. One line, only when there is more than one session, never on housekeeping (probes, cc, title requests).

Another machine works too: `las agent send --to Name@env --session codex` travels as `Name@env/codex` and is resolved over there, by that environment (unknown or closed session → it lands on the agent's default one, never lost). `las agent sessions --all` only maps this machine.

Local delivery is **queued, not lost**: every agent has a broker-owned mailbox (MQTT persistent session, `vortexia/PROTOCOL.md` "Mailboxes"). A message sent while the recipient has no session open waits there, in order, one entry per message — nothing overwrites anything (cap 500, TTL 30 days, survives a broker restart). A Claude session gets it live through the LAS channel (`las bridge`); anything else through `las bridge shell|exec|stdout`; `las agent poll` is the manual fallback. Only broadcast is live-only.

### Hierarchy — subordinates are read from the folders, never declared

A folder that holds several git repos (a client workspace, a monorepo of
sibling services) gets one agent for the container and one per repo. Nothing
in `.las-agent.json` says who reports to whom: an agent whose folder sits
under another agent's folder *is* its subordinate, computed from the
registered paths every time it's asked (`cli/hierarchy.py`,
`GET /agents/{name}/hierarchy`). Move the folder and the hierarchy follows.

Only git repositories get a subordinate agent — a vault's note folders or
asset directories under the same parent are not agents.

```bash
# From the parent agent's folder: one subordinate per git repo
las agent new relay-ros --dir relay-ros --voice Paulina

las agent children [Parent] [--deep]   # who reports to Parent (direct, or whole subtree)
las agent parent [Child]               # who Child reports to
las agents --tree                      # whole registry as a tree

# Talk to every subordinate at once — one vortexia inbox delivery each
las agent send --to Parent --children "<message>" --from Parent [--deep]
```

A session opened inside a subordinate's folder is that subordinate (the
nearest config upward wins); a session in a non-repo folder under the parent
(notes, docs) is the parent. Give subordinates the parent's voice so the
name in the widget/inbox is what tells them apart, not the voice.

### Known issues

**Rosetta / Node x86_64** — Pulpo and NeuroFlow have `node_modules` installed with Intel Node (`~/.nvm/versions/node/v20.20.2` is x86_64). `@esbuild/darwin-x64` runs under Rosetta. Pending fix:
```bash
arch -arm64 nvm install 20 && nvm use 20 && rm -rf node_modules && npm install
```

**Wavi Chrome renderers** — Wavi runs multiple headless Chrome instances for WhatsApp. High CPU from renderers with `--user-data-dir=.../wavi/data/sessions/` is normal, not a threat.

**"can't connect" while the backend is up = your sandbox, not LAS** — `las agent send` printing "the backend is running on :8700 but this process can't connect to it" (older builds said "backend not running" even then) means the CALLER has no network: typically a Codex session whose permissions were narrowed mid-session to workspace-write with network off (seen 2026-10-08 on dev-simulator). Don't report LAS as down. Fix: `/permissions` → Full access in that Codex, or reopen with `las codex resume`. `las codex` already passes `--yolo`; repeating it is harmless now.

**Codex resumes in a stale folder after a rename** — `codex resume` returns to the working directory recorded with the session, not the one it is launched from (seen 2026-10-14 when Relay renamed `agents` → `local-agents`: resumed sessions kept executing in the removed path). `las codex` now always passes `-C <current dir>` (physical path) to new sessions, `resume` and `fork`. Fix for a stuck session: exit it and reopen with `las codex resume` from the new folder; no workspace alias is needed. Prefer `las codex resume <session-id>` or `--last`: the bare picker filters by the current folder, so after a rename it can't find the folder's old sessions and it is easy to pick ANOTHER agent's conversation. Two Codex TUIs on one conversation (they share Codex's app-server daemon) mirror each other, so every message to one shows up in the other (dev-relay-brain ↔ Team Knowledge, 2026-10-14). `las codex` now holds mailbox messages while the picker is open, so a message can never choose a session.

**Terminal left in raw mode after `las codex` / `las claude --pty` / `las claudeRelay`** — output stair-steps (LF without CR) and `exec zsh` doesn't fix it, because the state lives on the tty. Fix it now with `stty sane`. Cause: `las` puts the terminal in raw mode for the PTY and only restored it on a normal return; a SIGTERM/SIGHUP/SIGINT/SIGQUIT killed it before the restore (seen 2026-10-14 in Ghostty). `cli/pty_session.py` (`TerminalGuard`) now restores on every signal too, and `las` returns as soon as the TUI exits instead of waiting for whatever it left holding the PTY. Claude's and Codex's goodbye (`claude --resume <id>`, `codex resume <id>`) names the bare binary, which loses LAS and, for a second account, uses the wrong login: in the PTY, `las` prints `With LAS: las claudeRelay --resume <id>` (or `las claude …`, `las codex resume …`) right after it. Channel-mode `las claude` hands the terminal to Claude by exec, so it can't add that line there.

**playwright-mcp zombies** — Every Claude terminal can accumulate `node playwright-mcp --browser chromium` processes. Safe to kill.

**sharp/libvips blocked by allowScripts (mic dictation)** — On uy-mac, `sharp@0.32.6` wasn't in the local `allowScripts` allowlist, so its postinstall (which downloads the native `libvips-cpp.42.dylib` binary) never ran — audio recorded fine but transcription always failed with "Something went wrong installing the sharp module -- Library not loaded: @rpath/libvips-cpp.42.dylib". Not a `widget-electron/package.json` problem (no `allowScripts` is declared there, on ba-mac or apparently on uy-mac before the fix either) — looks like npm/environment config specific to that machine. Fix applied on uy-mac: add `sharp@0.32.6:true` to its `allowScripts`, `npm install sharp@0.32.6`, rebuild. Never happened on ba-mac (sharp+libvips already present, transcriptions confirmed ok in `session/widget.log`). If it shows up on another machine: same fix.

---

## 7. Act when spoken to — trust the other agent

A recurring failure mode: agents wait passively to collaborate until the human explicitly tells them to. Don't. When another agent messages you via vortexia — a request, a question, a heads-up — that message itself is the trigger to act. You don't need the human to relay it, confirm it, or say "go ahead" first.

Why this matters: the human being present in a chat with one agent doesn't mean they're watching every agent's terminal. They're often on WhatsApp, in a call, or talking to a different member of the team entirely. If every inter-agent message sits idle until a human happens to notice and greenlight it, the society isn't actually autonomous — it's a human manually relaying messages between terminals, which is the exact problem vortexia was built to remove.

In practice: when you receive a message from another agent (via the live listener or a poll), evaluate it and act — investigate, fix, reply, escalate — the same way you would if the human had asked you directly. Keep the human informed of what you did and why (the closing report in §2 covers this), but don't block on their approval to start.

---

## 8. The widget — what it is and how to interact with it

The widget is not a log viewer. The terminal is still where the noise lives — cascades of tool output and log lines. The widget is one level of abstraction above that: a running summary of what happened and how the agents (this one, and the ones it's been talking to) have been conversing. That's what makes it the right interface for a human staying in the loop across a whole society of agents, rather than a stream of raw text from any one of them.

It's also a **signpost**: its label reminds you, when you switch desktops or sit down at a different computer, what that context is for — which tools, tabs, and specialized session live there. As more machines join the society (see §4), the widget on each one is that machine's own signpost, and the two (or more) machines' widgets, together, show how agents across the whole society have been talking to each other — not just what one agent, alone, has been doing.

**What you should know about how it renders a conversation** (`widget-electron/renderer/widget.js`): there are exactly three distinct bubble kinds, and they never merge into one another:
- **Mic dictation** — a self-send from the human to this agent (`source: "human"`, `from === to === agentName`). Renders on the right, labeled "mic."
- **This agent's own voice** — TTS output from the speech queue (`from: "queue"`, `kind: "speak"`). Renders centered, no name attached — the widget's own title is the implicit speaker.
- **Messages from other agents** — anything else. Renders on the left, always showing the sender's name as a color-chip pill tinted with *that agent's own* widget color (the same color you'd see on their widget).

A dictated message must never read as this agent talking to itself, and a message from another agent must never read as either of the other two kinds — if you're building or touching widget UI, preserve that distinction; it's deliberate, not an oversight.

Managed exclusively via `las start` / `las widget [name]` / `las stop` — never launch the Electron binary directly (see the project `CLAUDE.md`, "Widget management," for why). `las widget` closes and reopens the window on the current Space rather than just focusing it, so a widget stuck on another Space always comes back to wherever you are.

---

## 9. LAS Agent Scope Ladder — symbolic identity on a Fibonacci scale

Every LAS agent has, besides its `name` (mandatory — it's the widget's sign), an OPTIONAL ladder of increasingly detailed descriptions of its scope/task. The goal: a human, or a future vortexia router, can ask for "a short summary," "a bit more," or "the full detail" of an agent and get back text of a bounded size, without opening its terminal.

**Mind the ownership split** — deliberately spread across two repos:
- `docs/adr/0001-las-agent-scope-ladder.md` (in `local-agent-society`) defines ONLY the first 3 rungs — how fields that already existed in `.las-agent.json` (`name`/`short_description`/`long_description`) map onto the base of the ladder. That's the only part specific to LAS.
- `vortexia/docs/vxia-scope-ladder.md` (sibling `vortexia` repo) defines the file convention (`.vxia-scope.<N>.md`), how a README fits in, and how rung collisions are resolved — this is vortexia's protocol, not LAS's, because vortexia is the one that will eventually scan/embed/route on top of this. It isn't coupled to `local-agent-society`; any other project could adopt the same file convention independently.

**The rungs** (all optional except `name`; the caps are *soft*, same spirit as `report_max_chars` — never truncate existing content, they're a writing target):

| Rung | Cap (chars, Fibonacci) | Lives in | Spec owner |
|---|---|---|---|
| 0 | 34 | `name` in `.las-agent.json` (**mandatory**) | LAS |
| 1 | 55 | `short_description` in `.las-agent.json` | LAS |
| 2 | 89 | `long_description` in `.las-agent.json` | LAS |
| 3+ | 144, 233, 377, 610, 987, 1597, 2584, 4181… | `.vxia-scope.<N>.md` at the agent's root (one per rung) | vortexia |
| — | whichever fits its actual length | `README.md`, if the agent has one | vortexia |

**`.las-agent.json` is the whole identity of an agent instance** — name, voice, locale, the direct strings above, and `scope_docs`: the paths (relative to the agent's folder, most specific first) of the documents that carry its longer rungs — a README, `.vxia-scope.<N>.md` files, any doc this implementation chooses. Discovered once when missing (`.vxia-scope.<N>.md` ascending, then `README.md`); after that it is the agent's choice — edit the list, don't rely on rediscovery. `las agent normalize [--all]` fills whatever a file lacks without overwriting anything (docs/adr/0001 addendum). The old `.agent.json` is retired: never read, never write it.

**Key rules** (rungs 3+ and the README, defined by vortexia — summary; see `vxia-scope-ladder.md` for detail):
- `README.md` is **never renamed**. Its rung is computed: measure its real length in characters and place it at the smallest Fibonacci number that contains it — a short README lands on an early rung, a long one on a later one. There's no fixed "README rung."
- If two sources claim the same rung (e.g. an explicit `.vxia-scope.144.md` and a README whose real length also lands on 144): warn on the console and keep the first one in this scan order — `name` → `short_description` → `long_description` → `.vxia-scope.*` ascending → `README.md` last. An explicit file always beats an incidental README-size match.
- When helping document an agent's scope (a new one, or on explicit request), propose filling in at least `short_description`/`long_description`; if more detail is needed, add a `.vxia-scope.<N>.md` instead of continuing to inflate the JSON.
- There isn't (yet) a numeric agent ID — the identity that matters for lookup/routing is this one, the symbolic one (name + scope ladder).
- Automatic collision scanning and any vortexia routing on top of this ladder are future work (see `vortexia/docs/future-las-agent-scope-router.md` in the sibling `vortexia` repo) — today this is a convention applied by hand/judgment by whichever agent is in session, not something a script runs on its own.

---

## 10. Terminal tint — the terminal is a signpost too

**Intent:** whenever it can, an agent's terminal shows that agent's widget color as its background, so a glance at any terminal says which agent's folder it is in — the same signpost job the widget does (§8). Adapt to whatever terminal you find; the mechanism below is just the first known case, not the definition.

**What exists today** — `las shell-init` (zsh), proposed by System 2026-10-12:

```bash
las shell-init --install   # adds one `source .../shell/las-shell-init.zsh  # las shell-init` line to ~/.zshrc (idempotent)
las shell-init             # prints the snippet instead
```

On every `cd` (and at shell start) the hook finds the nearest `.las-agent.json` upward — the same rule LAS uses everywhere — reads `.name`, takes `agents.<name>.color` from the widget prefs (`~/Library/Application Support/widget-electron/widget-electron-prefs.json` on macOS), mixes it `LAS_BG_MIX`% (default 15) over `LAS_BG_BASE` (default `101010`) so text stays readable, and sets it with **OSC 11** (`\e]11;#rrggbb\a`). Outside any agent folder it sends **OSC 111** to restore the terminal's own background. `LAS_TINT=0` turns it off; `LAS_TINT_FORCE=1` tries it in an unlisted terminal. The sourced file lives in this repo (`shell/las-shell-init.zsh`), so a `git pull` updates every shell — never hand-paste the hook into `~/.zshrc` again.

**Known terminals** — the experience log. When you meet a terminal not here, work out how it sets a background color, adapt `shell/las-shell-init.zsh` (detection in `_las_tint_supported`, the escape in `_las_osc`), add a row, commit:

| Terminal | Status | How |
|---|---|---|
| Ghostty | **verified** 2026-10-12 (System #192a1b, Teli #14252c, Pulpo #2c1422) | OSC 11 / OSC 111, `TERM_PROGRAM=ghostty` |
| iTerm2, WezTerm, kitty | enabled, not yet verified here | same OSC 11/111; detected by `TERM_PROGRAM` / `TERM=xterm-kitty` |
| tmux | enabled, not yet verified | wrapped as `\ePtmux;\e…\e\\`; needs `set -g allow-passthrough on` |
| Terminal.app | off | no known OSC 11 support — a profile switch via AppleScript is the likely route |
| Zellij | unknown | may swallow OSC 11 |
| bash, fish | not covered | the snippet is zsh; a port needs `PROMPT_COMMAND` / `--on-variable PWD` |

A terminal that ignores OSC 11 simply stays as it was — the hook is safe to leave on everywhere.
