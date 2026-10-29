# Handoff — the supervisor and audio capture (2026-10-14)

José described the next direction at the end of a session. These are his
ideas, put in order, plus what exists today that they can build on. Nothing
here is decided yet: he is still defining it. Section 4 lists what he needs
to settle before anyone writes code.

---

## 1. What José asked for (in his words, ordered)

**A. The auditing process gets more responsibilities.** It will grow into
the supervisor of the whole society. It needs:

- **A control UI** for the whole system: every agent, every widget, every
  session, at a glance and controllable.
- **A phone app** that does the same.

**B. Audio capture is central and top priority.** In every layer, meaning
today's widget and the future phone app, recording must:

1. **Record** whenever the person wants to.
2. **Make the recording safe**: it must never get lost.
3. **Last as long as needed**, with no artificial limit.
4. **Be stored on the device that records it.**
5. **Be as secure as possible.**
6. **Prove it is really recording** whenever it is supposed to be. It is not
   enough for the button to look red.
7. **Warn the person immediately** about anything that means we are not
   listening. Silence from the system must never be mistaken for "it's
   recording".

---

## 2. What exists today (the starting points)

### Supervision pieces, scattered

These three supervisors exist today with no shared home. A future supervisor
could absorb them, or stand above them and read what they report.

| Piece | Where | What it supervises | Its audit trail |
|---|---|---|---|
| Tile reconciler | `widget-electron/main.js` ("tile reconciler") | Every widget's size and tile, by macOS Space. Runs a heartbeat (0.5 s by default; heartbeat and shrink delay are settable from any widget's settings panel), verifies and retries, has a flap guard. | `[tiles]` lines in `session/widget.log`, plus `session/widget-tiles.json` |
| Speech queue + speaker lock | `backend/main.py` (`_drain_one`, `/queue/ack`) | One voice at a time, with phases `started` → `playing` (grant) → `done`. One drainer per machine (flock). | `[tts]` lines in `backend/logs/backend.log` and `session/widget.log` |
| Service entry point | `backend/service.sh` | That launchd, and only launchd, runs the backend. Removes strays. | stdout; launchd logs in `backend/logs/` |

There are also signals the supervisor could read:

- session registry: `GET /agents/{name}/sessions`, `las agent sessions --all`
- bridge status files: `session/bridge-<agent>@<sid>.json`
- port registry: `GET /ports`, `las ports audit`
- vortexia presence and mailboxes

`widget-tiles.json` is the first "state of the world as JSON" file. It is the
natural shape for what a control UI and a phone app would read.

### Audio capture today (widget only)

- Recording happens in the renderer: `getUserMedia` + `MediaRecorder`
  (`widget-electron/renderer/widget.js`, around "MAX_RECORDING_MS").
- Transcription is local Whisper (`Xenova/whisper-base`) in the main process
  (`transcribeAudio`, `main.js`).
- **The audio lives only in memory** (`recordedChunks`) until it is
  transcribed. If the app crashes, the machine sleeps or the renderer
  reloads, the recording is lost. Nothing is written to disk.
- **Hard cap of 90 minutes** (`MAX_RECORDING_MS`, a safety net for a
  forgotten stop).
- **Liveness is checked only by the mic self-test** (double-click). It checks
  that the track is live and pings a real session (`runMicSelfTest`, and
  `track.readyState === 'live'`). Nothing watches a recording *while* it
  runs: no level meter, no "bytes are arriving" heartbeat, no reaction to a
  device change or a muted or ended track.
- `[mic]` lines in `session/widget.log` record start, stop and transcribe.
  `restart-widget.sh` already reads them to tell whether a dictation is in
  progress.

**The gaps against section 1B:**

- No persistence, so (2) and (4) fail.
- A 90-minute cap, so (3) fails.
- No in-flight liveness, so (6) and (7) fail.
- No encryption at rest, so (5) is open.

---

## 3. Suggested shape (a proposal, for José to accept or change)

**Audio capture, as one contract for every device**, implemented by the
widget first and by the phone app later:

1. **Write chunks to disk as they arrive.** Use `MediaRecorder` with a
   timeslice of a few seconds and an append-only file per recording in the
   device's own storage. A crash then loses seconds at most, never the
   whole recording. Transcription reads the file, not memory. This removes
   the need for a duration cap.
2. **Run a liveness watchdog while recording.** It checks all three of these
   every second or two:
   - the track is `live`;
   - bytes are growing on disk;
   - the input level is not flat zero for longer than N seconds.

   If any check fails, it alerts the person at once in the widget (and the
   phone), with a sound and a visible state. That alert means "you are NOT
   being heard", which is different from "silence". Device change, sleep and
   permission revocation are explicit failure states.
3. **Encrypt at rest.** Use a per-device key held in the OS keychain (macOS
   Keychain, iOS Keychain or Android Keystore). Recordings never leave the
   device unless the person sends them.
4. **One state file per recorder**, like `widget-tiles.json` (for example
   `session/recordings.json`). It holds `recording | ok | degraded | lost`
   with reasons, so the supervisor, the control UI and the phone app all
   read the same truth.

**The supervisor:**

- **Who it is:** one process, likely the backend (it already has the queue,
  registries and HTTP). It collects each piece's state file or endpoint into
  one model of the society, and the control UI and the phone app read from
  there.
- **Its first job:** audit audio capture, because that is the declared
  priority.
- **The pieces it already has:** tiles, the speech queue, services, sessions
  and ports.

---

## 4. Open questions for José (decide before building)

1. **Phone app:** native (Swift/Kotlin), cross-platform (React Native or
   Flutter), or a PWA first? This decides what "store on the device" and
   "keychain" mean.
2. **Reach:** how does the phone talk to the Mac society? LAN only (vortexia
   direct), or also away from home (vortex-relay / Nostr, which already
   exists, see `vortexia/docs/vortex-relay-poc.md`)?
3. **Recordings:** are they kept forever, or deleted after transcription or
   after N days? Does anything ever sync them off the recording device?
4. **Alerts when not listening:** sound, notification, vibration, the widget
   flashing? And which failures count: a flat level for how many seconds?
5. **Control UI:** inside the widget app (a new window), a web page served by
   the backend, or an Artifact? What must it be able to *do*, as opposed to
   only show?
6. **Supervisor:** one supervisor for all machines in the society (ba-mac,
   uy-mac...), or one per machine with the phone seeing all of them?

---

## 5. State at handoff

Everything below is pushed to `origin/main` (up to 1157ce4):

- **779ee0b, d17189b:** `las claudeRelay`, a second Claude account as its own
  session runtime. When the account's org blocks Claude Code channels,
  messages are typed into the prompt through a PTY.
- **6803021:** widget tiles decided by macOS Space, with an audited reconciler
  (fixes widgets staying small, and the endless grow/shrink fight with Meet);
  a speaker lock so voices never overlap.
- **1157ce4:** `backend/service.sh`, so `las start`/`stop`/`restart` never
  spawn a manual backend next to launchd (ADR 0002 addendum).

Tests at handoff: Python 262, widget 146, bridge 38, all passing.
