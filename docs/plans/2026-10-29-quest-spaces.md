# Agent workspaces in VR — the Space where an agent lives, as one connected view

Status: plan (2026-10-29, revised the same day after three rounds with the
user). Owner: LasDev. Not started.
Decisions: a LAS feature in this repo; USB tethered; the real windows, not
a copy; NOT a cast of the desktop — a different view of it.

## Goal

From a Meta Quest 2: for each macOS Space where a LAS agent lives, a
**workspace view** — the agent, the terminals on that Space and the Chrome
tabs on that Space, shown as one connected arrangement rather than as the
desktop's pixel layout. Several workspaces laid out in the room (mosaic,
ring in Mission Control order, or positions you place). Point to go there,
to focus a terminal, to switch a tab; work in those windows with the
physical keyboard as at the desk; talk to the agent.

What it is not: a desktop mirror. The desktop's layout, the menu bar and
the wallpaper are not what you see; the *things* on it are, re-arranged.

## The workspace view

One agent's Space becomes:

- **The agent** at the center: its name in its color (same as the widget),
  its state (active / speaking / listening), its last spoken summary (the
  speech-bubble feed), a mic affordance (later).
- **Its terminals**: every terminal window on that Space (Terminal.app
  today; iTerm2/Ghostty by owner name), each a panel showing the *real*
  window, captured live when you look at it and as a thumbnail otherwise.
  The LAS session registry knows which of them are the agent's own
  sessions (a Claude, a Codex, a shell — `las agent sessions`) and which
  are just terminals on that Space; the agent's own ones are drawn
  attached to it, the others beside.
- **Its Chrome tabs**: every tab of every Chrome window on that Space, as
  a strip or fan of cards (title, favicon, url; a thumbnail cached the
  last time that tab was visible). The active tab of each window is the
  live window capture. Point at a card → Chrome switches to it (and the
  live capture follows).
- **Connections**: lines from the agent to its sessions; tabs grouped by
  their Chrome window; everything on the Space is one cluster. Membership
  is the Space (a window is on it or not); LAS can enrich it later (which
  terminal is which session, which tabs an agent opened).

Several workspaces in the room: *mosaic* (a wall), *ring* (around you,
Mission Control order, the current one ahead), *fixed* (grab and place,
persisted). A Space with no agent is a plain workspace with no center.

## Interaction model

- The headset is a view and a navigator. **Typing stays on the physical
  keyboard and trackpad**, received by the Mac natively: the terminal you
  are in at the desk is the one you are in with the headset on,
  mid-command. Pointing with the controller switches Space, focuses a
  window, switches a tab; later, clicks and scrolls into the live panel.
- Nothing is re-implemented: a terminal panel is the real window's
  pixels, not a terminal emulator of ours. (A text-level view of a
  session is a possible later addition, not the base.)
- The Mac is the source of truth; taking the headset off or putting it on
  changes nothing.

## What was verified today (spikes in the session scratchpad)

- Quest 2 connected over USB; no `adb` on this Mac yet (`brew install
  android-platform-tools`; developer mode on the headset). `adb reverse`
  makes `http://localhost:PORT` on the headset reach the Mac: a secure
  context, so WebXR works with no certificates.
- macOS 14.5, Electron 33, Google Chrome installed.
- Electron's `desktopCapturer` only sees windows on the current Space (2 of
  385): not usable for other Spaces.
- CoreGraphics from plain Node (koffi, as `lib/spaces.js` already does)
  lists every window on every Space and captures windows on other Spaces
  with real pixels: 29 of 40 off-Space normal windows (the misses are
  nameless Chrome helper windows); a Terminal on another Space came back
  fully legible. Window → Space from CGS, Space order from
  `CGSCopyManagedDisplaySpaces`, both already in `lib/spaces.js`.
  `CGWindowListCreateImage` is deprecated since macOS 14 but works;
  ScreenCaptureKit (Swift) is the later higher-frame-rate path.
- Screen Recording is granted to the Electron dev binary; the packaged app
  will prompt once.

Because the unit is a *window*, not the display, there is no full-desktop
stream and no WebRTC-over-USB problem: per-window live capture (CG, one
window at a time, 10–20 fps at 1x, JPEG or WebCodecs H.264 over the
WebSocket through the USB tunnel) is enough to work in a terminal.

## Architecture

### 1. `las-spaces` (Node, new `spaces/` in this repo) — the world and the eyes

A Node process on a registry port, started by `start.sh`.

- **World model** over WebSocket (`/world`), rebuilt every ~1 s from
  `CGWindowListCopyWindowInfo`: displays → Spaces (ordered, current) →
  windows (CG id, app, title, bounds, z-order, Space); agents and their
  sessions from the LAS backend (`/agents`, `las agent sessions`, their
  Space from `session/widget-tiles.json`); Chrome windows and tabs from
  the extension (§2), matched to CG windows by title + bounds.
- **Pixels**: `GET /thumb/:wid?w=480` (JPEG at 1x via
  `kCGWindowImageNominalResolution`, sharp resize); `WS /live/:wid` — the
  window being looked at, 10–20 fps, ≤1440 px wide.
- **Commands**: `POST /space/:id/activate` (focus a window on it; spike for
  Spaces with none of ours), `POST /window/:wid/focus`,
  `POST /chrome/tab/:id/activate` (§2), `POST /agent/:name/speak|inject`
  (LAS backend), later `POST /input` (CGEvent click/scroll; Accessibility).
- **Layouts**: `data/layouts.json` — named arrangements, per-Space
  placement for *fixed*; the active one.

### 2. Chrome extension (`chrome-extension/`, Manifest V3)

Service worker with a WebSocket to las-spaces: reports every window's
tabs (id, title, url, favicon, active, pinned) on each `tabs`/`windows`
event; caches a `captureVisibleTab` thumbnail whenever a tab becomes
active, so background tabs have a last-seen picture; accepts
activate-tab / focus-window commands.

### 3. Headset app (`xr/`, WebXR + three.js, served by las-spaces)

The workspace views above; controllers first, hands later. Reached as
`http://localhost:PORT` over USB.

## Phase 0 — done (2026-10-29)

- `adb` installed (`brew install --cask android-platform-tools`); the Quest 2
  needed Developer Mode and the USB-debugging prompt (both on the headset
  side). Android 14, OculusBrowser 154 (Chromium 154).
- Port **9002** claimed in the LAS registry as `las-spaces`;
  `spaces/server.js` serves `spaces/xr/` and logs to `session/spaces.log`;
  `adb reverse tcp:9002 tcp:9002`; the page opens on the headset with
  `adb shell am start -a android.intent.action.VIEW -d http://localhost:9002/ com.oculus.browser`.
- Measured in the immersive session: **90 fps, 2 views**, and both a fetch
  and a WebSocket opened before entering VR keep working inside it.
- Gotcha: the reverse tunnel can go stale (still listed, passes nothing).
  `adb reverse --remove-all && adb reverse tcp:9002 tcp:9002`, then reload
  the page (its keep-alive sockets are dead too). A dead tunnel looked like
  "VR blocks fetch" for half an hour; it was not.
- DevTools over adb (`adb forward tcp:9222 localabstract:chrome_devtools_remote`)
  lets the Mac evaluate JS in the headset page — the way to debug without
  taking the headset off someone's head.

## Phases (each shippable, each a PR)

0. **Setup**: adb, developer mode, `adb reverse`, a hello-WebXR page from
   `localhost`; Screen Recording for the packaged app.
1. **Workspace on a flat page**: las-spaces with the world model, agent +
   terminals + (without the extension yet) Chrome windows for one Space,
   thumbnails, Space switch and window focus; a browser page on the Mac
   rendering one workspace view. Debuggable without the headset. Spike:
   switching to a Space with none of our windows on it.
2. **Chrome tabs**: the extension; tabs in the workspace; switch tab.
3. **In VR**: the workspace view in three.js, several workspaces as
   mosaic/ring, pointing to go there / focus / switch tab; live capture of
   the panel you look at — from here you can work with the headset on.
4. **Fixed layouts**: grab/place, named, persisted.
5. **Agent in the loop**: state, the speak feed as bubbles in VR,
   dictation from the Quest mic through the widget's Whisper path.
6. **Pointer input** into the live panel (CGEvent). Keyboard stays physical.

## Risks

- **CPU on a loaded Mac** (load ~15 today from a Docker VM): 1x captures,
  thumbnails only for views in sight, one live window at a time, rates
  configurable; measured in phase 1.
- **Legibility**: Quest 2 is 1832×1920 per eye; a terminal panel at
  ≥1080 px wide on a large virtual panel is readable; 1x capture of a
  Retina window halves the work without losing text.
- **Switching to a Space with nothing of ours on it**: spike in phase 1
  (CGS `CGSManagedDisplaySetCurrentSpace`, or a ctrl+arrow CGEvent).
- **Deprecated capture API**: works on 14.5; a contained swap to
  ScreenCaptureKit inside las-spaces when needed.
- **Which tabs are an agent's**: v1 = all tabs on the Space; enrichment
  later.
