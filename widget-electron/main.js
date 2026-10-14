'use strict';

/**
 * Electron replacement for widget/tray.swift (native macOS widget).
 *
 * Scope for this pass (see report / task description for the full list):
 *   - one Electron process, one window per agent name
 *   - single-instance lock + a `localagentsociety://<name>?action=reopen`
 *     protocol that DESTROYS and RECREATES the window (not just focuses it),
 *     matching the Swift "reopen moves the widget to the current Space"
 *     behavior documented in CLAUDE.md
 *   - a system tray icon with a menu of known agents
 *   - vortexia (MQTT) integration for inter-agent messages + speak requests,
 *     replacing the old AppleScript/tty-injection pipeline
 *   - minimal settings (color, opacity, always-on-top, mute) via electron-store
 *
 * Explicitly NOT ported: marquee text, drag-to-link-tty, and the command
 * palette from tray.swift (its trimmed-down port was later removed in favor
 * of the two-action "Open" button — see the agent:open section below). (Mosaic/tiling layout for multiple occlusion-expanded
 * widgets sharing a display WAS ported — see mosaicTiles + the tile reconciler
 * below.)
 * (Mic/STT dictation IS implemented — via local offline Whisper, not the
 * Web Speech API; see the "audio transcription" section below for why.)
 *
 * IMPORTANT re: AppleScript/Apple Events — a past incident in this project
 * revoked Apple Events TCC permissions on every rebuild of the retired Swift
 * tray binary, because it made IN-PROCESS NSAppleEventDescriptor calls tied
 * to that binary's own code-signing identity, which changed on every
 * recompile. That does NOT apply to spawning the `osascript` CLI as a child
 * process — macOS attributes that automation permission to the stable
 * `osascript` binary itself, not to this app, so it survives rebuilds fine
 * (the backend, backend/main.py, has done this safely all along for focus/
 * terminal). Window focus/raise in THIS file still uses only
 * BrowserWindow#show()/#focus() and app.focus({ steal: true }) — no
 * AppleScript needed there. The one legitimate spawned-osascript use in this
 * app is openTerminalAtPath()'s macOS branch (a NEW Ghostty/iTerm2 window at
 * the agent's folder, for the "Open" button) — see its own comment, and
 * test/test_widget_electron.js's tests enforcing osascript stays confined
 * to that one function and no in-process Apple Events appear anywhere.
 */

const { app, BrowserWindow, ipcMain, screen, session, powerMonitor, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const Store = require('electron-store');
const { createTray } = require('./tray');
const spaces = require('./lib/spaces');

// Real protocol scheme, claimed by this Electron app as of the full cutover
// (see CLAUDE.md task history). The Swift app (widget/tray.swift) previously
// owned `localagentsociety://`; install.sh no longer registers that scheme
// for the Swift .app bundle (its CFBundleURLTypes claim was removed), so
// LaunchServices resolves it exclusively to this Electron app. widget/
// sources are left untouched — only their Info.plist registration changed.
const PROTOCOL_SCHEME = 'localagentsociety';
const REGISTRY_URL = process.env.LAS_REGISTRY_URL || 'http://localhost:8700';

// ── persistent logging (session/widget.log) ─────────────────────────────────
// Launched via `open` (see start.sh), so this process's stdout/stderr goes
// nowhere any tool can read — console.log/warn here were silent in practice.
// This app has always assumed one fixed checkout of this repo (see the
// hardcoded vortexia file: dependency in package.json); resolving the log
// path the same way keeps this working both unpacked (`npm start`, __dirname
// is widget-electron/) and packaged (__dirname is inside app.asar, so the
// repo-relative candidate doesn't exist and we fall back to the known
// checkout path). Format matches the project-wide convention documented in
// the log-debug skill and tailed by `/log-debug ui`:
//   [ISO8601_TIMESTAMP] LEVEL [component] message
function resolveSessionLogPath() {
  const devPath = path.join(__dirname, '..', 'session', 'widget.log');
  if (fs.existsSync(path.dirname(devPath))) return devPath;
  return '/Users/josetabuyo/Development/local-agent-society/session/widget.log';
}
const SESSION_LOG_PATH = resolveSessionLogPath();

function writeLog(level, component, message) {
  try {
    const line = `[${new Date().toISOString()}] ${level.padEnd(5)} [${component}] ${message}\n`;
    fs.appendFileSync(SESSION_LOG_PATH, line);
  } catch {
    // best-effort — never let logging itself break the app
  }
}
const log = {
  debug: (component, message) => writeLog('DEBUG', component, message),
  info: (component, message) => writeLog('INFO', component, message),
  warn: (component, message) => writeLog('WARN', component, message),
  error: (component, message) => writeLog('ERROR', component, message),
};

/**
 * Which agent this launch is for. Mirrors how the Swift tray discovers it:
 * this app reads the same registry as `cli/commands/agents.py` /
 * `backend/main.py`'s `/agents` endpoint, and can also be told explicitly
 * via `--agent=<name>` (used by `las widget <name>`-equivalent launches) or
 * by pointing it at a working directory containing `.las-agent.json`.
 *
 * Resolved BEFORE app.whenReady()/requestSingleInstanceLock() because the
 * single-instance lock is scoped by userData path (see below): without a
 * per-agent userData dir, `requestSingleInstanceLock()` is global to the
 * whole widget-electron app, so agent B's launch would be silently blocked
 * by agent A's already-running instance instead of opening its own window.
 */
function resolveInitialAgentNames(argv) {
  const flag = argv.find((a) => a.startsWith('--agent='));
  if (flag) return [flag.slice('--agent='.length)];

  const cwdFlag = argv.find((a) => a.startsWith('--cwd='));
  const dir = cwdFlag ? cwdFlag.slice('--cwd='.length) : process.cwd();
  for (const filename of ['.las-agent.json']) {
    try {
      const raw = fs.readFileSync(path.join(dir, filename), 'utf8');
      const json = JSON.parse(raw);
      if (json && json.name) return [json.name];
    } catch {
      // try next filename
    }
  }
  return null; // signal "open everything known to the registry"
}

const initialAgentNames = resolveInitialAgentNames(process.argv);
// Scope userData (and therefore the single-instance lock) per agent when we
// know which one this launch is for. A launch with no explicit agent (opens
// "everything known to the registry") keeps the default shared userData —
// there's only ever one such "all agents" launcher instance anyway.
if (initialAgentNames && initialAgentNames.length === 1) {
  app.setPath(
    'userData',
    path.join(app.getPath('appData'), `widget-electron-${initialAgentNames[0]}`)
  );
}

const store = new Store({ name: 'widget-electron-prefs' });

/** @type {Map<string, BrowserWindow>} */
const windows = new Map();
/** @type {Map<string, import('vortexia/src/client.js').VortexiaClient>} */
const vortexiaClients = new Map();

// ── single instance lock ────────────────────────────────────────────────────
// Per-agent (see userData scoping above): two different agents' widgets can
// run simultaneously; two launches for the SAME agent still dedupe to one.

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL_SCHEME}://`));
    if (url) {
      handleProtocolUrl(url);
    } else {
      // No URL passed (e.g. someone just re-ran `npm start`): bring the
      // most recently used window forward instead of doing nothing.
      const first = windows.values().next().value;
      if (first) {
        first.show();
        first.focus();
      }
    }
  });
}

// ── protocol registration ───────────────────────────────────────────────────

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

// macOS delivers the URL via 'open-url', often immediately on cold launch —
// before 'ready' fires. handleProtocolUrl -> reopenWidget -> createWidgetWindow
// calls screen.getPrimaryDisplay(), and Electron's screen module throws if
// used before 'ready', so defer until the app is actually ready.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (app.isReady()) {
    handleProtocolUrl(url);
  } else {
    app.whenReady().then(() => handleProtocolUrl(url));
  }
});

/**
 * Parse `localagentsociety://<name>?action=reopen` and route it.
 * @param {string} rawUrl
 */
function handleProtocolUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (parsed.protocol !== `${PROTOCOL_SCHEME}:`) return;
  // macOS percent-encodes disallowed characters (e.g. a literal space in an
  // agent name like "Minis App Acces") before delivering the URL via
  // 'open-url' — parsed.hostname/pathname come back still encoded ("Minis%20
  // App%20Acces"), which must be decoded back before use. Using it raw would
  // key this widget's window/prefs/vortexia connection under a name that
  // never matches the agent's real (decoded) name used everywhere else,
  // producing a second, duplicate widget for the same agent.
  let name = parsed.hostname || parsed.pathname.replace(/^\/+/, '');
  try {
    name = decodeURIComponent(name);
  } catch {
    // malformed percent-encoding — fall back to the raw string
  }
  if (!name) return;
  const action = parsed.searchParams.get('action');

  if (action === 'reopen') {
    reopenWidget(name);
  } else if (action === 'close') {
    closeWidget(name);
  } else if (action === 'rename') {
    const to = parsed.searchParams.get('to');
    if (to) renameWidget(name, to);
  } else {
    openWidget(name);
  }
}

// ── window management ───────────────────────────────────────────────────────

// Visible and active are the same thing for now (see the `las agent
// deactivate`/inactive design discussion) — any deliberate single-agent open
// (tray click, `las widget NAME`, the explicit-agent launch path) clears the
// inactive flag, whether or not the window already existed. Fire-and-forget:
// never block window creation on this, and a failed request just means the
// backend hasn't caught up yet, not a reason to refuse opening the widget.
// The BULK "open everything" path (app.whenReady()) filters inactive agents
// out before ever calling openWidget, so this never fires for those.
function clearInactiveRemote(name) {
  fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(name)}/inactive`, { method: 'DELETE' }).catch(() => {});
}

/**
 * Focus an existing window for `name`, or create one. Does NOT destroy an
 * existing window — that's reopenWidget's job.
 */
function openWidget(name) {
  clearInactiveRemote(name);
  const existing = windows.get(name);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  return createWidgetWindow(name);
}

/**
 * Destroy the existing window for `name` (if any) and create a fresh one.
 * This is what actually moves the widget to the current macOS Space — a
 * plain .focus() does not, which was the whole point of the ?action=reopen
 * fix documented in CLAUDE.md / tests/test_widget_reopen.py.
 */
function reopenWidget(name) {
  clearInactiveRemote(name);
  const existing = windows.get(name);
  if (existing && !existing.isDestroyed()) {
    existing.destroy();
    windows.delete(name);
  }
  return createWidgetWindow(name, { forgetPosition: true });
}

/**
 * Follow a rename: destroy the window open under `oldName` (if any) and
 * open a fresh one under `newName`. `las agent rename` only ever patched
 * the backend registry and the agent's own config file — a widget window
 * already open under the old name kept running unchanged, so a later
 * `las widget` under the new name opened a SECOND, overlapping window
 * instead of updating the first (reported by DataLake).
 *
 * No-op if nothing is open for oldName: a rename with no widget currently
 * open has nothing to migrate — the next `las widget` under the new name
 * opens cleanly on its own, same as any first-time open.
 */
function renameWidget(oldName, newName) {
  const existing = windows.get(oldName);
  if (!existing || existing.isDestroyed()) return;
  existing.destroy();
  windows.delete(oldName);
  createWidgetWindow(newName, { forgetPosition: true });
}

/**
 * Destroy the existing window for `name`, if any, and do NOT recreate it —
 * the "door" button / `las agent deactivate` use this to put a widget away.
 * No-op if the widget isn't currently open.
 */
function closeWidget(name) {
  const existing = windows.get(name);
  if (existing && !existing.isDestroyed()) {
    existing.destroy();
    windows.delete(name);
  }
}

// Distinct-enough hues, fixed saturation/lightness so every one stays
// readable under the widget's dark (#141414) text — see widget.css .name/.log.
function randomWidgetColor() {
  const hue = Math.floor(Math.random() * 360);
  return hslToHex(hue, 55, 65);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (n) => Math.round(255 * f(n)).toString(16).padStart(2, '0');
  return `#${toHex(0)}${toHex(8)}${toHex(4)}`;
}

const WIDGET_WIDTH = 300;
const WIDGET_HEIGHT = 160;

function createWidgetWindow(name, { forgetPosition = false } = {}) {
  // Random color ONLY the first time this agent ever gets a widget — once a
  // color exists (whether from that first randomization or a manual pick in
  // settings), every later start/reopen respects it, it's never overwritten.
  // Check the raw stored value, not getPrefs()'s defaulted view, so we can
  // tell "never set" apart from "happens to equal the fallback".
  const hasStoredColor = !!(store.get(`agents.${name}`) || {}).color;
  if (!hasStoredColor) {
    setPrefs(name, { color: randomWidgetColor() });
  }
  const prefs = getPrefs(name);
  // Position/size: like Chrome remembering where a window sat before it was
  // closed, reuse the last bounds this agent's widget was left at (see
  // getSavedBounds/saveBounds below). Only first-ever open (or a saved spot
  // that's now off any connected display, e.g. an external monitor got
  // unplugged) falls back to a fresh random spot so widgets don't stack.
  //
  // `forgetPosition` (set by reopenWidget, i.e. `las widget`/the tray "reopen"
  // action) skips the saved bounds on purpose: that command exists to grab a
  // widget that's stuck or hard to find, so reappearing at the exact same
  // spot defeats the point — it needs a fresh, easy-to-spot position instead.
  // A plain relaunch (`las start`) still restores the last position, since
  // that IS the desired continuity there.
  const saved = !forgetPosition && getSavedBounds(name);
  let bounds;
  if (saved && boundsOnScreen(saved)) {
    bounds = saved;
  } else {
    const display = screen.getPrimaryDisplay();
    const { x: sx, y: sy, width: aw, height: ah } = display.workArea;
    bounds = {
      x: sx + Math.floor(Math.random() * Math.max(1, aw - WIDGET_WIDTH)),
      y: sy + Math.floor(Math.random() * Math.max(1, ah - WIDGET_HEIGHT)),
      width: WIDGET_WIDTH,
      height: WIDGET_HEIGHT,
    };
  }

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    resizable: true,
    alwaysOnTop: prefs.alwaysOnTop !== false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false so preload.js can `require('./lib/voiceHash')` (a local,
      // pure-JS, dependency-free module) directly. contextIsolation:true still
      // keeps the renderer's main world free of any Node/Electron access —
      // everything is funneled through the explicit contextBridge surface.
      sandbox: false,
      // backgroundThrottling stays at its default (true/on) here — do NOT
      // set false unconditionally. Tried that first: it does make an
      // occluded page keep painting, but Chromium's occlusion-based
      // throttling and its Page Visibility (document.hidden) reporting turn
      // out to share the same underlying signal, so disabling throttling
      // also stops 'hidden' from ever firing at all — confirmed live
      // (zero visibilitychange events across a real Space switch with
      // throttling permanently off, vs. firing correctly with it on).
      // The actual fix is dynamic: the tile reconciler below
      // flips webContents.setBackgroundThrottling() off ONLY once occlusion
      // has already been detected (so detection keeps working via the
      // default throttled behavior), and back on when collapsing.
    },
  });

  // macOS: participate in every Space like the Swift widget's
  // `.collectionBehavior = [.managed, .participatesInCycle]`.
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: false });
  }

  // color/opacity ride along in the query string so widget.js can paint
  // the real widget color on its very first frame instead of a flash of
  // widget.css's placeholder green while waiting on the async
  // window.las.getPrefs() IPC round-trip (see widget.js's initialParams
  // block, right below where agentName is read).
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { agent: name, color: prefs.color, opacity: String(prefs.opacity) },
  });

  // Space (macOS virtual desktop) memory: a window is only ever placed on
  // whichever Space is currently active at creation time — there's no way to
  // create it "on" a different Space directly. So once it's actually on
  // screen (electron assigns a CGWindowID only once shown — see
  // lib/spaces.js), move it to its saved Space, if any, matching where the
  // agent's own bounds already put it. Own-window-only, see lib/spaces.js.
  //
  // moveWindowToSpace goes through CGSMoveWindowsToManagedSpace — a private,
  // direct connection call that bypasses the normal AppKit window-ordering
  // path. A hide()+show() nudge to force a fresh occlusion notification after
  // this move was tried here and reverted live: show()'ing a window that
  // lives on an inactive Space makes macOS switch the user's ACTIVE SPACE to
  // reveal it — exactly the kind of disruptive, screen-stealing behavior the
  // occlusion-expanded banner is designed to never cause (see the
  // tile reconciler comment below on staying click-through and
  // non-blocking). Do not reintroduce hide()/show() (or any focus/order-front
  // call) as a fix here without confirming live that it does NOT move the
  // user off their current Space. Turned out unnecessary anyway: the priming
  // resync just below (reading document.visibilityState directly, not
  // waiting on the event) already reports the correct post-move state in
  // practice — confirmed live after rebuilding the app (see
  // feedback_widget_electron_build memory: most of one debugging session was
  // actually spent testing a stale prebuilt bundle that had none of these
  // changes in it).
  const savedSpace = getSavedSpace(name);
  if (savedSpace != null) {
    win.once('show', () => {
      setTimeout(() => spaces.moveWindowToSpace(win, savedSpace), 150);
    });
  }

  // Prime occlusion state without waiting to be looked at: a widget that
  // starts life already off the active Space (e.g. `las start` recreates
  // every agent's window while you're sitting on just one Space) may never
  // get an initial 'hidden' visibilitychange event — Chromium/AppKit only
  // push a DELTA when occlusion changes, and a window that's occluded from
  // the moment it's first shown can have no prior "visible" state to change
  // FROM, so the very first push can be missed. Ask the renderer to read its
  // OWN current document.visibilityState directly (a live property, not the
  // event) and apply it — correct immediately, including right after the CGS
  // Space move above.
  win.once('show', () => {
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send('system:resume');
    }, 3000);
  });

  // Forward renderer console output to the main process's stdout — handy
  // for headless smoke-testing and debugging; harmless in normal use.
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[widget:${name}]`, message);
  });

  win.agentName = name;

  win.on('closed', () => {
    windows.delete(name);
    occlusionExpandedWindows.delete(win);
    const client = vortexiaClients.get(name);
    if (client) {
      client.close().catch(() => {});
      vortexiaClients.delete(name);
    }
  });

  // Persist bounds like Chrome persists a window's position/size — but only
  // while the widget is in its normal compact face. While a settings/
  // commands panel or the occlusion banner is expanded, 'move'/'resize' keep
  // firing (setBounds triggers them same as a user drag), and saving those
  // would clobber the real collapsed position with the panel's blown-up one.
  const persistBounds = () => {
    if (expandedWindows.has(win) || occlusionExpandedWindows.has(win)) return;
    if (win.isDestroyed()) return;
    saveBounds(name, win.getBounds());
  };
  win.on('move', persistBounds);
  win.on('resize', persistBounds);

  // Persist which Space this widget is on right now. There's no Electron/
  // AppKit event for "the user dragged this window to another Space" — so
  // this piggybacks on events that correlate with the window having settled
  // somewhere: move/resize (a drag can end on a different Space than it
  // started, e.g. a swipe mid-drag) and focus (switching Spaces to reach a
  // window and clicking it is the single most common way its Space changes).
  const persistSpace = () => {
    if (win.isDestroyed()) return;
    const current = spaces.getSpaceForWindow(win);
    if (current != null) saveSpace(name, current);
  };
  win.on('move', persistSpace);
  win.on('resize', persistSpace);
  win.on('focus', persistSpace);

  windows.set(name, win);
  connectVortexia(name, win);
  return win;
}

// ── window bounds (position/size) persistence ───────────────────────────────
// Chrome-style "reopen where it was" — separate from prefs.color/opacity/etc
// above since it's per-window geometry, not a user setting, and is skipped
// entirely (falls back to random placement) until an agent's widget has
// actually been moved/resized at least once.

function getSavedBounds(name) {
  return store.get(`bounds.${name}`) || null;
}

function saveBounds(name, bounds) {
  store.set(`bounds.${name}`, {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });
}

// Guards against a saved spot that's no longer reachable (e.g. an external
// display that hosted it got unplugged) — screen.getDisplayMatching falls
// back to the nearest display when a rect doesn't overlap the point/rect on
// any display, which is a lot more forgiving than an exact bounds check.
function boundsOnScreen(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const { x, y, width, height } = display.workArea;
  return (
    bounds.x + bounds.width > x &&
    bounds.x < x + width &&
    bounds.y + bounds.height > y &&
    bounds.y < y + height
  );
}

// Space ids (CGSSpaceID) are 64-bit and come back as JS BigInt from
// lib/spaces.js — electron-store's JSON backing can't serialize BigInt
// directly, so store/read them as decimal strings.
function getSavedSpace(name) {
  const raw = store.get(`space.${name}`);
  return raw == null ? null : BigInt(raw);
}

function saveSpace(name, spaceId) {
  store.set(`space.${name}`, spaceId.toString());
}

// ── prefs (electron-store) ──────────────────────────────────────────────────

const DEFAULT_PREFS = {
  color: '#90c060',
  opacity: 0.72,
  alwaysOnTop: true,
  mute: false,
  // On by default per explicit request — most agents on this machine want
  // the ambient "still here" banner while off-Space/occluded.
  expandWhenHidden: true,
  // Mic dictation language hint for Whisper — independent of the agent's
  // TTS voice locale (an agent can speak English while being dictated to in
  // Spanish). Defaults to Spanish per explicit request; 'auto' lets Whisper
  // auto-detect instead of forcing a language.
  micLanguage: 'es',
  // "Open" button actions, in menu order — the FIRST one is what a plain
  // click runs; press-and-hold shows the menu that reorders them.
  openOrder: ['terminal', 'folder'],
  // Where a mic dictation goes is NOT a window pref: it is the agent's own
  // `sessions.target` in its .las-agent.json (children button), read and
  // written through the backend — see agent:config-sessions below.
};

function getPrefs(name) {
  return { ...DEFAULT_PREFS, ...(store.get(`agents.${name}`) || {}) };
}

function setPrefs(name, patch) {
  const next = { ...getPrefs(name), ...patch };
  store.set(`agents.${name}`, next);
  return next;
}

ipcMain.handle('prefs:get', (_event, name) => getPrefs(name));
ipcMain.handle('prefs:set', (_event, name, patch) => {
  const next = setPrefs(name, patch);
  const win = windows.get(name);
  if (win && !win.isDestroyed() && typeof patch.alwaysOnTop === 'boolean') {
    win.setAlwaysOnTop(patch.alwaysOnTop);
  }
  return next;
});

// Manual resize: frameless windows have no native resize border, and a
// full-window drag region (see widget.css) swallows edge mousedowns before
// the OS can start a native resize anyway (see the CSS comment on
// .resize-handle). The renderer's corner grip sends deltas here instead.
ipcMain.on('window:resize-by', (event, dw, dh) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const minW = 160;
  const minH = 100;
  win.setBounds({
    x: b.x,
    y: b.y,
    width: Math.max(minW, Math.round(b.width + dw)),
    height: Math.max(minH, Math.round(b.height + dh)),
  });
});

// Drawers (settings, the Open menu, the children menu) are inline panels
// in normal flow below the button bar — never popovers, never overlays —
// so showing one means the window itself must get taller by the drawer's
// height. The renderer measures the drawer and calls setExpanded(true,
// totalHeight); setExpanded(false) restores the compact bounds remembered
// on the first expand. Re-fitting while already expanded is allowed (a
// drawer re-rendered taller, or one drawer replaced another).
const EXPANDED_HEIGHT = 460;
/** @type {WeakMap<BrowserWindow, {x:number,y:number,width:number,height:number}>} */
const collapsedBounds = new WeakMap();
/** @type {WeakSet<BrowserWindow>} */
const expandedWindows = new WeakSet();

ipcMain.on('window:set-expanded', (event, expanded, height) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (expanded) {
    // Grow DOWN only: same x/y/width, taller. The compact bounds are
    // remembered once, on the first expand; a later call while already
    // expanded just re-fits the height (a drawer re-rendered, or another
    // drawer replaced it) — see widget.js's fitWindowToDrawer.
    if (!expandedWindows.has(win)) {
      collapsedBounds.set(win, win.getBounds());
      expandedWindows.add(win);
    }
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: height || EXPANDED_HEIGHT });
  } else if (expandedWindows.has(win)) {
    expandedWindows.delete(win);
    const prev = collapsedBounds.get(win);
    if (prev) win.setBounds(prev);
  }
});

// "Expand when hidden" — restores the retired Swift widget's "Expand on
// space change" feature (Prefs.expandOnSpaceChange / activeSpaceChanged in
// the retired tray.swift, see swift-widget-final tag): when the widget
// isn't visible to the user (covered by another window, or you switched to
// a different macOS Space), it balloons to fill the screen as a big
// attention-grabbing name banner, then shrinks back once visible again.
//
// Trigger: the renderer's `document.visibilitychange` (Page Visibility API)
// — on macOS, Chromium's compositor ties this to real window occlusion
// (covered by another window OR moved off the active Space), which is the
// same underlying signal the Swift version read via NSWindowOcclusionState/
// activeSpaceDidChangeNotification. There's no direct "is this window on
// the active Space" API in Electron, so this is the closest equivalent
// without a native module.
//
// Why this can't block your work (the concern that shaped this design): the
// expanded window is made fully click-through via setIgnoreMouseEvents, so
// even though it visually covers the screen, every mouse/keyboard event
// passes straight through to whatever is actually behind it — it can never
// intercept a click or a keystroke meant for your terminal. It's a pure
// visual banner, matching how the Swift version also hid all its buttons
// (non-interactive) while expanded.
//
// Off by default per agent (matches Prefs.expandOnSpaceChange's default),
// toggled from the settings panel.
//
// Mosaic tiling: when several widgets are occlusion-expanded on the SAME
// display at once (their Spaces share a screen), filling each one's bounds
// with the full workArea makes them stack exactly on top of each other.
// The retired Swift widget avoided this via AppDelegate.mosaicTiles/
// applyMosaicLayout (swift-widget-final tag, tray.swift); the tile shapes
// below are ported from it, the decision of WHEN to grow is the tile
// reconciler further down.
/** @type {Set<BrowserWindow>} */
const occlusionExpandedWindows = new Set();

// Deterministic: the same group always gets the same layout. The Swift
// original picked a random layout for 2 and 3 windows on every run, so a
// re-layout of an unchanged group could reshuffle tiles — fine when it ran
// once per Space switch, wrong for a reconciler that re-checks every tick.
// `seed` (a hash of the group key) still varies the layout between Spaces.
// Edges are rounded so every tile is whole pixels and they meet exactly.
function mosaicTiles(count, workArea, seed = 0) {
  const { x: x0, y: y0, width: W, height: H } = workArea;
  if (count <= 0) return [];
  const xs = (n) => Array.from({ length: n + 1 }, (_, i) => x0 + Math.round((W * i) / n));
  const ys = (n) => Array.from({ length: n + 1 }, (_, i) => y0 + Math.round((H * i) / n));
  const cell = (X, Y, c0, c1, r0, r1) => ({ x: X[c0], y: Y[r0], width: X[c1] - X[c0], height: Y[r1] - Y[r0] });
  if (count === 1) return [{ x: x0, y: y0, width: W, height: H }];
  const X2 = xs(2);
  const Y2 = ys(2);
  if (count === 2) {
    return seed % 2 === 0
      ? [cell(X2, ys(1), 0, 1, 0, 1), cell(X2, ys(1), 1, 2, 0, 1)]
      : [cell(xs(1), Y2, 0, 1, 0, 1), cell(xs(1), Y2, 0, 1, 1, 2)];
  }
  if (count === 3) {
    const X1 = xs(1);
    const Y1 = ys(1);
    const X3 = xs(3);
    const layouts = [
      [cell(X1, Y2, 0, 1, 0, 1), cell(X2, Y2, 0, 1, 1, 2), cell(X2, Y2, 1, 2, 1, 2)], // top full, bottom 2
      [cell(X2, Y2, 0, 1, 0, 1), cell(X2, Y2, 1, 2, 0, 1), cell(X1, Y2, 0, 1, 1, 2)], // top 2, bottom full
      [cell(X2, Y1, 0, 1, 0, 1), cell(X2, Y2, 1, 2, 0, 1), cell(X2, Y2, 1, 2, 1, 2)], // left full, right 2
      [cell(X2, Y1, 1, 2, 0, 1), cell(X2, Y2, 0, 1, 0, 1), cell(X2, Y2, 0, 1, 1, 2)], // right full, left 2
      [cell(X3, Y1, 0, 1, 0, 1), cell(X3, Y1, 1, 2, 0, 1), cell(X3, Y1, 2, 3, 0, 1)], // 3 columns
    ];
    return layouts[seed % layouts.length];
  }
  // 4+: 2 columns, as many rows as needed.
  const rows = Math.ceil(count / 2);
  const Y = ys(rows);
  const tiles = [];
  for (let i = 0; i < count; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    tiles.push(cell(X2, Y, col, col + 1, row, row + 1));
  }
  return tiles;
}

function seedFor(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

// ── tile reconciler: grow a widget to its mosaic tile when it is OFF-Space ──
//
// Why a widget grows at all: so Mission Control's thumbnail of each Space
// shows that Space's agents big and legible — that is the only reason.
//
// What decides it: whether the widget sits on a Space that is NOT the one its
// display is showing right now (lib/spaces.js, CGS). The old trigger was the
// renderer's document.visibilitychange — Chromium's occlusion, which is the
// same signal for "on another Space" and "covered by another app's window".
// That caused two long-standing bugs:
//   - a foreign window (Google Meet's floating one) covering a widget made it
//     grow, growing changed what covered what, it shrank, got covered again —
//     an endless grow/shrink fight (the newer window always "won");
//   - each widget reported on its own lazy schedule and the mosaic batched
//     whoever had reported in a 350ms window, so stragglers (or a widget whose
//     report never came) were left out of the grid and stayed small.
// Now main decides for every widget, on a heartbeat, from one snapshot:
//   - covered on the CURRENT Space → stays compact, nothing to fight over;
//   - the whole Space's group is tiled together, every tick, so a late widget
//     joins its grid and a group that changes is re-laid out;
//   - every tile is verified on the next tick (getBounds == target) and
//     re-applied if macOS didn't take it.
// When CGS can't say (non-macOS, private API gone), the renderer's visibility
// report is the fallback signal — with a flap guard so an occlusion fight
// latches compact instead of looping.
//
// Calm by design (no hurry: the grown face is only seen in Mission Control):
// a change of mind must hold TILE_EXPAND_SETTLE_MS / TILE_COLLAPSE_SETTLE_MS
// before acting, so a Space swipe back and forth or a Mission Control glance
// never makes a widget pump. Audit: every transition and every miss goes to
// session/widget.log ([tiles]), and the full current picture to
// session/widget-tiles.json.

const TILE_TICK_MS = 1500;              // heartbeat
const TILE_EXPAND_SETTLE_MS = 2500;     // off-Space this long before growing (unseen, so no rush)
const TILE_COLLAPSE_SETTLE_MS = 1200;   // back on screen this long before shrinking
const TILE_FLAP_WINDOW_MS = 60 * 1000;  // more than TILE_FLAP_MAX grows in this window...
const TILE_FLAP_MAX = 4;
const TILE_FLAP_LATCH_MS = 2 * 60 * 1000; // ...latches the widget compact this long
const TILE_TOLERANCE_PX = 2;
const TILE_MAX_RETRIES = 3;
const TILES_STATUS_PATH = path.join(path.dirname(SESSION_LOG_PATH), 'widget-tiles.json');

/** @type {WeakMap<BrowserWindow, object>} */
const tileStates = new WeakMap();

function tileStateOf(win) {
  let st = tileStates.get(win);
  if (!st) {
    st = { want: false, since: 0, flips: [], latchedUntil: 0, retries: 0, reportedHidden: false, allowed: true, why: '', space: null, target: null };
    tileStates.set(win, st);
  }
  return st;
}

// Group by (physical display, macOS Space) — NOT display alone: grouping by
// display lumped every expanded widget on the machine into one giant grid
// (seen live: 13 agents in a 2x7 grid) though each Space's thumbnail only
// shows its own. Unknown Space falls back to a shared 'u' bucket per display.
function mosaicKeyFor(win, spaceId = spaces.getSpaceForWindow(win)) {
  const displayId = screen.getDisplayMatching(collapsedBounds.get(win) || win.getBounds()).id;
  return `${displayId}:${spaceId != null ? spaceId.toString() : 'u'}`;
}

/** Should this widget be grown right now, and why (for the audit). */
function desiredTileState(win, st) {
  if (!st.allowed) return { want: false, why: 'expandWhenHidden off', space: null, mode: 'pref' };
  const space = spaces.getSpaceForWindow(win);
  const current = space != null ? spaces.getCurrentSpaceForWindow(win) : null;
  if (space != null && current != null) {
    const off = space !== current;
    return { want: off, why: off ? `off-Space (on ${space}, showing ${current})` : 'on the current Space', space, mode: 'space' };
  }
  return { want: st.reportedHidden, why: st.reportedHidden ? 'hidden (no Space info)' : 'visible (no Space info)', space, mode: 'visibility' };
}

function expandToTile(win, st) {
  collapsedBounds.set(win, win.getBounds());
  occlusionExpandedWindows.add(win);
  // Click-through: the grown face must never block typing into whatever is
  // actually on screen.
  win.setIgnoreMouseEvents(true, { forward: true });
  // Let the banner paint while off-Space (throttling would freeze it compact).
  win.webContents.setBackgroundThrottling(false);
  win.webContents.send('window:occlusion-state', true);
  st.retries = 0;
  log.info('tiles', `${win.agentName}: grow — ${st.why}`);
}

function collapseFromTile(win, st) {
  occlusionExpandedWindows.delete(win);
  win.setIgnoreMouseEvents(false);
  win.webContents.setBackgroundThrottling(true);
  const prev = collapsedBounds.get(win);
  if (prev) win.setBounds(prev);
  win.webContents.send('window:occlusion-state', false);
  st.target = null;
  st.retries = 0;
  log.info('tiles', `${win.agentName}: shrink — ${st.why}`);
}

function offTarget(bounds, target) {
  return ['x', 'y', 'width', 'height'].some((k) => Math.abs(bounds[k] - target[k]) > TILE_TOLERANCE_PX);
}

/** Tile every grown widget, group by group, and verify the last tick's tiles landed. */
function layoutGrownWidgets() {
  const groups = new Map();
  for (const win of occlusionExpandedWindows) {
    if (win.isDestroyed()) continue;
    const key = mosaicKeyFor(win, tileStateOf(win).space);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(win);
  }
  for (const [key, group] of groups) {
    group.sort((a, b) => (a.agentName || '').localeCompare(b.agentName || ''));
    const display = screen.getDisplayMatching(collapsedBounds.get(group[0]) || group[0].getBounds());
    const tiles = mosaicTiles(group.length, display.workArea, seedFor(key));
    group.forEach((win, i) => {
      const st = tileStateOf(win);
      const target = tiles[i];
      const bounds = win.getBounds();
      if (!offTarget(bounds, target)) {
        if (st.retries > 0) log.info('tiles', `${win.agentName}: on its tile after ${st.retries} retr${st.retries === 1 ? 'y' : 'ies'}`);
        st.retries = 0;
        st.target = target;
        return;
      }
      const sameTarget = st.target && !offTarget(st.target, target);
      if (sameTarget) {
        // Set last tick and still not there: macOS didn't take it. Retry, loudly.
        st.retries += 1;
        if (st.retries <= TILE_MAX_RETRIES) {
          log.warn('tiles', `${win.agentName}: not on its tile (${JSON.stringify(bounds)} ≠ ${JSON.stringify(target)}) — retry ${st.retries}/${TILE_MAX_RETRIES}`);
        } else if (st.retries === TILE_MAX_RETRIES + 1) {
          log.error('tiles', `${win.agentName}: still off its tile after ${TILE_MAX_RETRIES} retries — will keep re-applying quietly`);
        }
      } else {
        log.info('tiles', `${win.agentName}: tile ${i + 1}/${group.length} on ${key} → ${JSON.stringify(target)}`);
      }
      st.target = target;
      win.setBounds(target);
    });
  }
}

let lastTilesStatus = '';
let lastTilesStatusAt = 0;

function writeTilesStatus(now) {
  const widgets = [];
  for (const [name, win] of windows) {
    if (win.isDestroyed()) continue;
    const st = tileStateOf(win);
    const grown = occlusionExpandedWindows.has(win);
    const bounds = win.getBounds();
    widgets.push({
      name,
      space: st.space != null ? st.space.toString() : null,
      grown,
      want: st.want,
      why: st.why,
      onTile: grown ? Boolean(st.target) && !offTarget(bounds, st.target) : null,
      retries: st.retries,
      latched: st.latchedUntil > now,
      bounds,
      tile: grown ? st.target : null,
    });
  }
  const body = JSON.stringify({ widgets }, null, 2);
  if (body === lastTilesStatus && now - lastTilesStatusAt < 60 * 1000) return;
  lastTilesStatus = body;
  lastTilesStatusAt = now;
  try {
    fs.writeFileSync(TILES_STATUS_PATH, JSON.stringify({ updatedAt: new Date(now).toISOString(), widgets }, null, 2));
  } catch {
    // audit is best-effort
  }
}

function reconcileTiles(now = Date.now()) {
  let pending = false;
  for (const win of windows.values()) {
    if (win.isDestroyed() || !win.isVisible()) continue;
    // A settings/commands panel is open: that mechanism owns the size.
    if (expandedWindows.has(win)) continue;
    const st = tileStateOf(win);
    const d = desiredTileState(win, st);
    st.why = d.why;
    st.space = d.space;
    if (d.want !== st.want) {
      st.want = d.want;
      st.since = now;
    }
    const grown = occlusionExpandedWindows.has(win);
    if (st.want === grown) continue;
    if (now - st.since < (st.want ? TILE_EXPAND_SETTLE_MS : TILE_COLLAPSE_SETTLE_MS)) {
      pending = true;
      continue;
    }
    if (st.want) {
      if (now < st.latchedUntil) continue;
      st.flips = st.flips.filter((t) => now - t < TILE_FLAP_WINDOW_MS);
      if (st.flips.length >= TILE_FLAP_MAX) {
        st.latchedUntil = now + TILE_FLAP_LATCH_MS;
        log.warn('tiles', `${win.agentName}: grew ${st.flips.length}x in ${TILE_FLAP_WINDOW_MS / 1000}s (${d.mode}: ${d.why}) — staying compact for ${TILE_FLAP_LATCH_MS / 1000}s`);
        continue;
      }
      st.flips.push(now);
      expandToTile(win, st);
    } else {
      collapseFromTile(win, st);
    }
  }
  layoutGrownWidgets();
  writeTilesStatus(now);
  if (pending) kickTiles(400);
}

let tilesKick = null;
/** Run the reconciler soon (a renderer reported a visibility change, a Space likely switched). */
function kickTiles(delay = 250) {
  if (tilesKick) return;
  tilesKick = setTimeout(() => {
    tilesKick = null;
    reconcileTiles();
  }, delay);
}

// The renderer reports its visibility (and whether this agent wants to grow
// at all). It no longer decides anything: main does, above.
ipcMain.on('window:report-visibility', (event, hidden, allowed) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const st = tileStateOf(win);
  st.reportedHidden = Boolean(hidden);
  st.allowed = allowed !== false;
  kickTiles();
});

// ── face buttons: "Open" — a terminal, or the folder, at the agent's path ──
//
// Replaces the retired command palette (a per-agent list of saved
// openTerminal/sendMessage commands, dropped as unused). The button has
// exactly two actions, both anchored on the agent's registered directory
// (the `path` the backend registry holds for it — never a user-typed cwd):
//   terminal — a NEW WINDOW of the default terminal, shell started in the
//              agent's folder
//   folder   — the agent's folder revealed in the file manager (Finder)
// Which one a plain click runs is the first entry of the agent's
// `openOrder` pref (DEFAULT_PREFS); the renderer's press-and-hold menu lets
// the user reorder them. Neither action touches an existing terminal.
//
// Why AppleScript for the terminal action on macOS: `open -a Ghostty <dir>`
// works but Ghostty (its `macos-dock-drop-behavior` default is `new-tab`)
// adds a TAB to the frontmost window — right where the user is typing —
// instead of opening a window of its own, which is what the button is for.
// Ghostty 1.2+ ships a scripting dictionary whose `new window` takes an
// `initial working directory`, so that's what's used; iTerm2 gets its own
// classic `create window` script. This is the SPAWNED `osascript` CLI, not
// in-process Apple Events — see the header comment on why that's safe, and
// test/test_widget_electron.js keeps it confined to openTerminalAtPath.
// The new window lands on the current Space by itself (whoever presses the
// button is on the widget's desktop), so no positioning is attempted —
// Ghostty's dictionary exposes none anyway.

const OPEN_ACTIONS = ['terminal', 'folder'];

// macOS has no LaunchServices "default terminal" role, so "default" is
// resolved here: the first INSTALLED app in this list wins. Ghostty is the
// terminal the user treats as this machine's default; iTerm2 is what the
// backend still drives for focus/tty-write; Terminal.app always exists.
// LAS_TERMINAL_APP in the environment overrides the whole list.
const TERMINAL_APP_CANDIDATES = ['Ghostty', 'iTerm', 'Terminal'];

function resolveTerminalApp() {
  if (process.env.LAS_TERMINAL_APP) return process.env.LAS_TERMINAL_APP;
  if (process.platform !== 'darwin') return null;
  const roots = ['/Applications', path.join(os.homedir(), 'Applications'), '/System/Applications/Utilities'];
  for (const name of TERMINAL_APP_CANDIDATES) {
    for (const root of roots) {
      if (fs.existsSync(path.join(root, `${name}.app`))) return name;
    }
  }
  return 'Terminal';
}

// Both scripts take the directory as argv[1] — never interpolated into the
// script text, so a path with quotes can't break out of it.
const GHOSTTY_NEW_WINDOW_SCRIPT =
  'on run argv\n' +
  '  set dir to item 1 of argv\n' +
  '  tell application "Ghostty"\n' +
  '    new window with configuration {initial working directory:dir}\n' +
  '    activate\n' +
  '  end tell\n' +
  'end run\n';

const ITERM_NEW_WINDOW_SCRIPT =
  'on run argv\n' +
  '  set dir to item 1 of argv\n' +
  '  tell application "iTerm2"\n' +
  '    create window with default profile\n' +
  '    tell current session of current window to write text "cd " & quoted form of dir\n' +
  '    activate\n' +
  '  end tell\n' +
  'end run\n';

/** Open a NEW terminal window whose shell starts in `cwd`. Returns the name
 * of the terminal app it used. */
function openTerminalAtPath(cwd) {
  const dir = cwd || os.homedir();
  if (process.platform === 'darwin') {
    const appName = resolveTerminalApp();
    const script = appName === 'Ghostty' ? GHOSTTY_NEW_WINDOW_SCRIPT : appName === 'iTerm' ? ITERM_NEW_WINDOW_SCRIPT : null;
    if (script) {
      const scriptPath = path.join(os.tmpdir(), `las-widget-open-${Date.now()}-${Math.random().toString(36).slice(2)}.applescript`);
      fs.writeFileSync(scriptPath, script);
      const child = spawn('osascript', [scriptPath, dir], { detached: true, stdio: 'ignore' });
      child.unref();
      child.on('exit', () => fs.unlink(scriptPath, () => {}));
    } else {
      // Terminal.app (and any other app named via LAS_TERMINAL_APP) opens a
      // new window at a directory handed to it this way.
      spawn('open', ['-a', appName, dir], { detached: true, stdio: 'ignore' }).unref();
    }
    return appName;
  }
  if (process.platform === 'win32') {
    // Untested (dev machine is macOS) — best-effort via cmd.exe.
    spawn('cmd', ['/c', 'start', 'cmd', '/k', `cd /d "${dir}"`], { detached: true, stdio: 'ignore', shell: true }).unref();
    return 'cmd';
  }
  // Linux best-effort fallback; varies a lot by distro/DE, no single
  // reliable command. x-terminal-emulator is a common Debian/Ubuntu alias.
  spawn('x-terminal-emulator', ['--working-directory', dir], { detached: true, stdio: 'ignore' }).unref();
  return 'x-terminal-emulator';
}

async function resolveAgentPath(name) {
  const agents = await fetchAgents();
  const entry = agents && agents[name];
  return entry && entry.path ? entry.path : null;
}

ipcMain.handle('agent:open', async (_event, name, action) => {
  if (!OPEN_ACTIONS.includes(action)) return { ok: false, error: `unknown open action: ${action}` };
  const dir = await resolveAgentPath(name);
  if (!dir) return { ok: false, error: `no registered path for agent ${name}` };
  try {
    if (action === 'folder') {
      const failure = await shell.openPath(dir); // '' on success, else an error string
      if (failure) return { ok: false, error: failure };
      log.info('open', `folder ${dir} for ${name}`);
      return { ok: true, action, path: dir };
    }
    const terminalApp = openTerminalAtPath(dir);
    log.info('open', `terminal (${terminalApp}) at ${dir} for ${name}`);
    return { ok: true, action, path: dir, app: terminalApp };
  } catch (err) {
    log.error('open', `${action} failed for ${name}: ${err && err.stack ? err.stack : err}`);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('terminal:default-app', () => resolveTerminalApp());

// ── face buttons: vortexia send primitive (mic dictation) ───────────────────
//
// Generalized "send this text to <toName> over vortexia" primitive, used by
// the mic button (dictation -> agent's own inbox, the closest faithful
// equivalent of the retired live-TTY injectToSession). Reuses the already-connected
// per-window VortexiaClient in `vortexiaClients` — does not open a second
// connection.

const SEND_TIMEOUT_MS = 8000;

function nameForWindow(win) {
  for (const [name, w] of windows) {
    if (w === win) return name;
  }
  return null;
}

ipcMain.handle('vortexia:send', async (event, toName, text) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const fromName = win ? nameForWindow(win) : null;
  if (!fromName) {
    log.error('mic', 'vortexia:send failed: could not resolve sending agent for this window');
    return { ok: false, error: 'could not resolve sending agent for this window' };
  }
  // First choice: the backend's /agents/send — the one place that knows the
  // recipient's connected sessions and its own `sessions.target` choice
  // (.las-agent.json, docs/adr/0005): last-used session, all of them, or
  // one, plus the for-the-record cc. The same routing `las agent send`
  // gets; this window never decides where a dictation lands.
  // The direct publish below is ONLY for a backend that could not be
  // reached at all. Any HTTP answer — even a 500 — means the backend ran
  // and may already have published; publishing again would deliver the
  // dictation twice. A hung backend is bounded by the timeout and reported
  // as an error, for the same reason.
  let reachedBackend = false;
  try {
    const body = { message: text, to: toName, source: 'human', from_agent: fromName };
    const res = await fetch(`${REGISTRY_URL}/agents/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    reachedBackend = true;
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.injected) {
      log.info('mic', `vortexia:send ok from=${fromName} to=${toName} mode=${json.mode} targets=${(json.targets || []).join(',') || '-'}${json.fallback_from ? ` fallback_from=${json.fallback_from}` : ''}${json.cc ? ' cc' : ''} chars=${text.length}`);
      return { ok: true, mode: json.mode, targets: json.targets || [], fallback_from: json.fallback_from || null, cc: Boolean(json.cc) };
    }
    log.error('mic', `vortexia:send failed: backend answered HTTP ${res.status} ${json.detail || ''}`);
    return { ok: false, error: json.detail || `HTTP ${res.status}` };
  } catch (err) {
    if (reachedBackend || (err && err.name === 'TimeoutError')) {
      log.error('mic', `vortexia:send failed after reaching the backend (${err && err.message ? err.message : err}) — not republishing, it may already be delivered`);
      return { ok: false, error: String(err) };
    }
    log.warn('mic', `vortexia:send via backend unreachable (${err && err.message ? err.message : err}) — publishing to the agent inbox directly`);
  }
  // Backend unreachable: the agent-level inbox is still a mailbox the
  // broker queues for whoever holds it (the default session's bridge), so
  // a dictation is never lost — only the session choice is skipped.
  const client = vortexiaClients.get(fromName);
  if (!client) {
    log.error('mic', `vortexia:send failed: no vortexia client connected for ${fromName}`);
    return { ok: false, error: 'vortexia client not connected' };
  }
  try {
    // sendConfirmed(), not send(): send() is fire-and-forget, and mqtt.js
    // QUEUES a QoS-1 publish instead of erroring when the socket died
    // without a clean FIN (exactly what happens after a vortexia
    // restart/keepalive-timeout — the client object survives in
    // vortexiaClients with a doomed connection). That silently ate mic
    // dictations and self-test pings while this handler kept logging "ok".
    // sendConfirmed() rejects if the broker never PUBACKs, so a dead
    // connection now surfaces as a real error instead of a lost message.
    await client.sendConfirmed(toName, text, { from: fromName, source: 'human' });
    log.info('mic', `vortexia:send ok (direct) from=${fromName} to=${toName} chars=${text.length}`);
    return { ok: true, mode: 'direct', targets: [], fallback_from: null, cc: false };
  } catch (err) {
    log.error('mic', `vortexia:send failed from=${fromName} to=${toName}: ${err && err.stack ? err.stack : err}`);
    // The connection is confirmed dead — drop it and reconnect immediately
    // rather than waiting on 'close' (which may never fire for a socket
    // that died without a clean FIN) so the next send has a fresh client.
    if (vortexiaClients.get(fromName) === client) {
      vortexiaClients.delete(fromName);
      if (win && !win.isDestroyed()) {
        win.webContents.send('vortexia:status', { connected: false, error: 'connection confirmed dead' });
        connectVortexia(fromName, win);
      }
    }
    return { ok: false, error: String(err) };
  }
});

// ── face buttons: this agent's voice + locale (for mic STT + TTS pickVoice) ─
//
// Reads the backend's agent registry (voice) and its NICE_VOICES catalogue
// (voice -> lang), same source of truth as CLAUDE.md rule 7 / rule 3's
// voice-language table, instead of duplicating that table here.

// Connected sessions of an agent — its children (a Claude, a Codex, a
// shell; docs/adr/0004 phase 2, docs/adr/0005): what the children button
// lists, with the agent's own `target`/`cc_default` choice. The backend
// prunes dead ones.
ipcMain.handle('agent:sessions', async (_event, name) => {
  // On any failure the policy is UNKNOWN (target: null), never a made-up
  // default — the renderer keeps showing the agent's last known choice.
  try {
    const res = await fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(name)}/sessions`);
    if (!res.ok) return { agent: name, default: null, target: null, cc_default: null, sessions: [] };
    return await res.json();
  } catch {
    return { agent: name, default: null, target: null, cc_default: null, sessions: [] };
  }
});

// The agent's own file, .las-agent.json, through the backend (it knows the
// path; this app never looks for the file itself). The children button
// writes `sessions.target` / `sessions.cc_default` here — the same file
// `las agent target` writes, so CLI and widget can never disagree.
ipcMain.handle('agent:config', async (_event, name) => {
  try {
    const res = await fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(name)}/config`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
});

ipcMain.handle('agent:config-sessions', async (_event, name, patch) => {
  try {
    const res = await fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(name)}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessions: patch || {} }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.error('children', `config patch failed for ${name}: HTTP ${res.status} ${json.detail || ''}`);
      return null;
    }
    log.info('children', `${name}: sessions config -> ${JSON.stringify(json.sessions && { target: json.sessions.target, cc_default: json.sessions.cc_default })}`);
    return json;
  } catch (err) {
    log.error('children', `config patch failed for ${name}: ${err && err.message ? err.message : err}`);
    return null;
  }
});

// The children menu's refresh button: ask every intelligent session of the
// agent to title itself (backend request_session_titles). Answers arrive
// later, as `las agent title` calls; the renderer re-reads the list.
ipcMain.handle('agent:request-session-titles', async (_event, name) => {
  try {
    const res = await fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(name)}/sessions/titles/request`, { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.error('children', `title request failed for ${name}: HTTP ${res.status} ${json.detail || ''}`);
      return null;
    }
    log.info('children', `${name}: asked ${json.asked.length} session(s) for a title, skipped ${json.skipped.length}`);
    return json;
  } catch (err) {
    log.error('children', `title request failed for ${name}: ${err && err.message ? err.message : err}`);
    return null;
  }
});

// `tts_voice` (optional, .las-agent.json): a Kokoro voice id (lib/kokoroVoices.js)
// the agent pins for itself — the renderer's speak() uses it instead of
// hashing the agent name into the locale's pool. Read through the backend's
// config view (the one process that knows every agent's path).
async function fetchPinnedTtsVoice(name) {
  try {
    const res = await fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(name)}/config`);
    if (!res.ok) return null;
    const view = await res.json();
    const pinned = view && view.config ? view.config.tts_voice : null;
    return typeof pinned === 'string' && pinned.trim() ? pinned.trim() : null;
  } catch {
    return null;
  }
}

ipcMain.handle('agent:info', async (_event, name) => {
  const ttsVoice = await fetchPinnedTtsVoice(name);
  try {
    const agents = await fetchAgents();
    const voice = agents && agents[name] ? agents[name].voice : null;
    if (!voice) return { voice: null, locale: 'en-US', ttsVoice };
    const res = await fetch(`${REGISTRY_URL}/voices/${encodeURIComponent(voice)}`);
    if (!res.ok) return { voice, locale: 'en-US', ttsVoice };
    const data = await res.json();
    return { voice, locale: data.lang || 'en-US', ttsVoice };
  } catch {
    return { voice: null, locale: 'en-US', ttsVoice };
  }
});

// "Door" button: mark this agent inactive on the backend, then close this
// very widget window — mirrors `las agent deactivate`. Does not touch the
// agent's Claude Code session (see backend/main.py's set_inactive comment).
ipcMain.handle('agent:deactivate', async (event, name) => {
  try {
    const res = await fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(name)}/inactive`, { method: 'POST' });
    const json = await res.json();
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.destroy();
    return json;
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// "Wake up via vortexia" settings checkbox — backed by the same
// inactive/wake-enabled flags `las agent focus` reads, not electron-store,
// so the CLI-driven wake fallback sees the same state the widget shows.
ipcMain.handle('agent:set-wake-enabled', async (_event, name, enabled) => {
  try {
    const res = await fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(name)}/wake-enabled`, {
      method: enabled ? 'POST' : 'DELETE',
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('agent:get-wake-enabled', async (_event, name) => {
  try {
    const res = await fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(name)}/wake-enabled`);
    return await res.json();
  } catch (err) {
    return { wake_enabled: false, error: String(err) };
  }
});

// Raw terminal write (types `text` into the agent's live linked terminal(s),
// the backend's AppleScript-via-iTerm mechanism — see backend
// POST /agents/{name}/tty-write). Used by the Clear button to send "/clear",
// matching the retired Swift widget's clearSession() exactly.
ipcMain.handle('agent:tty-write', async (_event, name, text) => {
  try {
    const res = await fetch(`${REGISTRY_URL}/agents/${encodeURIComponent(name)}/tty-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ── audio transcription (local Whisper via @xenova/transformers) ───────────
//
// The mic button used to rely on Chromium's built-in SpeechRecognition /
// webkitSpeechRecognition. That API is a cloud service tied to a Google API
// key that only official Chrome builds carry — verified live, it fails with
// error:"network" every time in Electron, even though getUserMedia (mic
// permission/access) works fine. This is a well-known Electron limitation
// with no flags/permissions fix; there is no working backend for
// webkitSpeechRecognition in Electron, full stop.
//
// Replacement: local, offline Whisper transcription, run in THIS (main/Node)
// process via @xenova/transformers (transformers.js) — same pattern as the
// vortexia import just below (a CJS file dynamic-import()ing an ESM
// dependency). The renderer keeps owning getUserMedia/MediaRecorder (see
// widget.js's mic section); it decodes the recorded clip to raw mono 16kHz
// PCM with the Web Audio API (a browser API, not Node — no sandbox issue)
// and ships that PCM over IPC. Inference itself never runs in the sandboxed
// renderer, matching every other Node-side feature in this file.
//
// Model: Xenova/whisper-base — multilingual (so it doesn't need a separate
// English-only variant per the locale system in CLAUDE.md), quantized
// (~140MB on disk). Started as whisper-tiny, but that was noticeably poor on
// Spanish dictation in practice (confirmed by the user); base is meaningfully
// more accurate on non-English speech/accents at a modest speed cost. Not
// bundled into the app: transformers.js downloads it into WHISPER_CACHE_DIR
// on first use and reuses it after that. First transcription after a fresh
// cache pays that download (tens of seconds to a couple minutes depending on
// connection) plus model load; every call after only pays inference time
// (a few seconds for a few-second dictation clip on a modern laptop CPU,
// using the onnxruntime-node native backend that ships alongside
// @xenova/transformers — see package.json's asarUnpack for
// why its native binaries must NOT be packed inside asar).
//
// Cache directory: deliberately NOT inside the per-agent userData path (see
// the userData-scoping comment near the top of this file) — that would
// download and store a separate copy of the model per agent. It sits one
// level up, under the app's shared appData root, so every agent's widget on
// this machine shares one cached model.

// whisper-tiny was noticeably poor on Spanish dictation (confirmed by the
// user) — whisper-base is meaningfully more accurate, especially on
// non-English speech and accents, while still small enough to run fast on
// CPU. If accuracy is still not good enough, Xenova/whisper-small is the
// next step up (bigger download, slower inference, better accuracy).
const WHISPER_MODEL = 'Xenova/whisper-base';
const WHISPER_CACHE_DIR = path.join(app.getPath('appData'), 'widget-electron-whisper-cache');

let whisperPipelinePromise = null;

/**
 * Lazily creates (and memoizes) the ASR pipeline. `onProgress` is only ever
 * actually useful the first time (subsequent calls resolve the already-
 * memoized promise without re-invoking the loader), which is fine — that's
 * exactly the "loading model…" case callers care about giving feedback for.
 */
function getWhisperPipeline(onProgress) {
  if (!whisperPipelinePromise) {
    log.info('mic', `whisper: loading model ${WHISPER_MODEL} (first use — cache=${WHISPER_CACHE_DIR})`);
    whisperPipelinePromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = WHISPER_CACHE_DIR;
      return pipeline('automatic-speech-recognition', WHISPER_MODEL, {
        quantized: true,
        progress_callback: onProgress,
      });
    })().then(
      (p) => {
        log.info('mic', 'whisper: model loaded');
        return p;
      },
      (err) => {
        log.error('mic', `whisper: model load failed: ${err && err.stack ? err.stack : err}`);
        whisperPipelinePromise = null; // allow retry on next dictation
        throw err;
      }
    );
  }
  return whisperPipelinePromise;
}

/**
 * @param {BrowserWindow|null} win window to push 'audio:status' progress to
 * @param {Float32Array} pcmFloat32 mono PCM samples at 16kHz (Whisper's
 *   expected input rate — the renderer resamples to this before sending)
 * @param {string|null} languageHint reduced language code (e.g. "en", "es")
 *   from the agent's resolved TTS locale, or null to let Whisper auto-detect
 * @returns {Promise<string>}
 */
async function transcribeAudio(win, pcmFloat32, languageHint) {
  const send = (status) => {
    if (win && !win.isDestroyed()) win.webContents.send('audio:status', status);
  };
  const durationS = (pcmFloat32.length / 16000).toFixed(1);
  log.info('mic', `transcribe: start samples=${pcmFloat32.length} (~${durationS}s) language=${languageHint || 'auto'}`);
  const startedAt = Date.now();
  const modelAlreadyLoaded = whisperPipelinePromise !== null;
  if (!modelAlreadyLoaded) send({ state: 'loading-model' });
  const transcriber = await getWhisperPipeline((progress) => {
    if (progress && progress.status === 'progress') {
      send({ state: 'loading-model', progress: progress.progress, file: progress.file });
    }
  });
  send({ state: 'transcribing' });

  // Whisper's encoder only sees 30s per forward pass; without chunking, any
  // dictation longer than that gets silently truncated instead of erroring
  // (confirmed by the user — dictated bubbles were cutting off). chunk_length_s
  // + stride_length_s makes transformers.js split long-form audio into
  // overlapping 30s windows and stitch the results back together.
  const options = { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 };
  if (languageHint) options.language = languageHint;
  let output;
  try {
    output = await transcriber(pcmFloat32, options);
  } catch (err) {
    // Not every language hint the locale system produces is guaranteed to
    // be one Whisper's language-token table accepts; degrade to
    // auto-detection rather than failing the whole dictation.
    if (options.language) {
      log.warn('mic', `transcribe: language hint "${options.language}" failed, retrying with auto-detect: ${err && err.message ? err.message : err}`);
      delete options.language;
      output = await transcriber(pcmFloat32, options);
    } else {
      log.error('mic', `transcribe: inference failed: ${err && err.stack ? err.stack : err}`);
      throw err;
    }
  }
  const text = (output && output.text ? output.text : '').trim();
  log.info('mic', `transcribe: done in ${Date.now() - startedAt}ms, ${text.length} chars`);
  return text;
}

// Lets the sandboxed renderer (no fs access) write into session/widget.log
// through the same logger the main process uses — needed because the mic
// click-handling, MediaRecorder, and PCM decode steps all run in the
// renderer, upstream of anything main.js sees.
ipcMain.on('log:write', (_event, level, component, message) => {
  writeLog(String(level || 'INFO'), String(component || 'widget'), String(message || ''));
});

ipcMain.handle('audio:transcribe', async (event, pcmBuffer, languageHint) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  try {
    const pcm = new Float32Array(pcmBuffer);
    const text = await transcribeAudio(win, pcm, languageHint || null);
    return { ok: true, text };
  } catch (err) {
    log.error('mic', `audio:transcribe IPC failed: ${err && err.stack ? err.stack : err}`);
    return { ok: false, error: String(err) };
  }
});

// ── local text-to-speech (Kokoro-82M, via the backend's /tts/synthesize) ────
//
// The widget's speak() used to call the renderer's window.speechSynthesis —
// Chromium's built-in TTS, which on macOS exposes only a thin compact voice,
// noticeably worse than both `say`'s default voices and the enhanced voices
// available in System Settings (confirmed by the user). Kokoro-82M (Apache
// 2.0) sounds clearly better and is free.
//
// Inference does NOT run in this process. It was first tried in-process
// (kokoro-js, Node's onnxruntime-node) but that breaks once packaged:
// electron-builder's own native-module rebuild step re-flattens
// node_modules, collapsing the onnxruntime-common version Kokoro needs back
// down to the older one Whisper (@xenova/transformers) pins — crashing
// Kokoro's tokenizer at runtime with a version this exact repo could
// reproduce, but never fix by pinning versions alone. The backend (a single
// Python/uvicorn process, its own onnxruntime, no packaging step at all) now
// owns synthesis via kokoro-onnx and exposes it over HTTP; this process just
// fetches the WAV and forwards it to the renderer. Bonus: kokoro-onnx's
// espeak-ng phonemizer is a real native binary (espeakng-loader), not the
// WASM build kokoro-js used — which is what made Spanish voices crash there
// but work fine here (see lib/kokoroVoices.js for the full voice pool).
async function synthesizeSpeech(text, voiceId, lang) {
  const res = await fetch(`${REGISTRY_URL}/tts/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: voiceId, lang }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`backend /tts/synthesize returned ${res.status}: ${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

ipcMain.handle('tts:synthesize', async (event, text, voiceId, lang) => {
  try {
    const startedAt = Date.now();
    const wav = await synthesizeSpeech(String(text || ''), String(voiceId || 'af_heart'), String(lang || 'en-us'));
    log.info('tts', `synthesized ${text.length} chars (voice=${voiceId}) in ${Date.now() - startedAt}ms`);
    return { ok: true, wav: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) };
  } catch (err) {
    log.error('tts', `tts:synthesize IPC failed: ${err && err.stack ? err.stack : err}`);
    return { ok: false, error: String(err) };
  }
});

// ── speak-queue handshake (backend/main.py's _drain_one) ───────────────────
//
// The backend's TTS drainer publishes one speak envelope at a time and then
// BLOCKS until the widget that plays it reports it over: that is what keeps
// two agents from talking at once, since playback happens in each agent's
// own widget process where nobody else can hear a clip end. The renderer
// reports 'started' on receipt, then 'done' after playback (or 'skipped'
// with a reason when it never played: muted, no voice, synthesis/playback
// failure). Plain HTTP like every other backend call here. An unreachable
// backend is not fatal — the drainer's own timeouts then pace the queue.
ipcMain.handle('queue:ack', async (_event, id, phase, reason, durationMs) => {
  const tag = `speak ${String(id).slice(0, 8)}`;
  try {
    const res = await fetch(`${REGISTRY_URL}/queue/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, phase, reason: reason || null, duration_ms: Number.isFinite(durationMs) ? durationMs : null }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.warn('tts', `${tag} ack ${phase} failed: HTTP ${res.status}`);
    } else if (json.known === false && phase === 'playing') {
      log.warn('tts', `${tag} refused: its turn already ended — dropped instead of overlapping the current voice`);
    } else if (json.known === false) {
      log.warn('tts', `${tag} ack ${phase}: backend no longer tracks it (drainer timed out first?)`);
    } else {
      log.info('tts', `${tag} ${phase}${reason ? ` (${reason})` : ''}`);
    }
    return { ok: res.ok, ...json };
  } catch (err) {
    log.warn('tts', `${tag} ack ${phase} failed: ${err && err.message ? err.message : err}`);
    return { ok: false, error: String(err) };
  }
});

// ── vortexia (MQTT) integration ─────────────────────────────────────────────
//
// Done in the MAIN process (Node context), not the renderer: main.js is a
// plain Node/CommonJS process so it can `import()` vortexia's ESM client
// directly (via the `file:../vortexia` dependency) and reuse its exact
// broker-discovery logic (vortexia.port.json -> :8700/ports registry ->
// 1883 fallback) instead of reimplementing it for a browser/WS transport.
// Renderer stays sandboxed/contextIsolated with no direct network access;
// main forwards messages over IPC.
//
// Speak-request convention (documented here since PROTOCOL.md does not yet
// define one): a normal vortexia envelope on `las/agent/<name>/inbox` with
// an added `"kind": "speak"` field:
//   { "kind": "speak", "from": "...", "to": "<name>", "source": "system",
//     "text": "...", "voice": "<optional voice name>", "ts": 172... }
// Anything without kind === "speak" is treated as a plain chat/log message.

async function connectVortexia(name, win) {
  if (vortexiaClients.has(name)) return;
  let VortexiaClient;
  try {
    ({ VortexiaClient } = await import('vortexia/src/client.js'));
  } catch (err) {
    win.webContents.send('vortexia:status', { connected: false, error: String(err) });
    return;
  }

  const client = new VortexiaClient();
  vortexiaClients.set(name, client);

  client.on('message', (envelope, topic) => {
    if (win.isDestroyed()) return;
    // las/speak is a shared topic (every agent's widget subscribes to it);
    // only forward speak requests actually addressed to this agent.
    if (envelope && envelope.kind === 'speak' && envelope.to !== name) return;
    win.webContents.send('vortexia:message', envelope, topic);
  });

  // The underlying MQTT client never retries on its own (see client.js's
  // reconnectPeriod: 0) — if vortexia restarts (its own crash-restart
  // supervisor, or a manual bounce) the port it claims from the registry
  // can change, so this connection just goes dead in silence: no more
  // messages, no more mic-self-test pong, with the UI still showing
  // connected. Without this, the only fix was quitting and relaunching the
  // whole app. On 'close', drop the stale client and retry connectVortexia
  // (which re-resolves the current port) after a short delay.
  client.on('close', () => {
    if (vortexiaClients.get(name) !== client) return; // already superseded
    vortexiaClients.delete(name);
    if (!win.isDestroyed()) {
      win.webContents.send('vortexia:status', { connected: false, error: 'connection closed' });
    }
    setTimeout(() => {
      if (!win.isDestroyed()) connectVortexia(name, win);
    }, 3000);
  });

  try {
    await client.register(name);
    // register() watches the agent-level inbox as a viewer. A message aimed
    // at ONE session (a dictation for the shell, `send --session`) goes to
    // las/agent/<name>/sessions/<sid>/inbox instead and would never show in
    // the log — watch those too. Still a viewer (clean session): it never
    // consumes anything, the session's own bridge does.
    client.mqttClient.subscribe(`las/agent/${name}/sessions/+/inbox`, { qos: 1 });
    if (!win.isDestroyed()) {
      win.webContents.send('vortexia:status', { connected: true });
    }
  } catch (err) {
    vortexiaClients.delete(name);
    if (!win.isDestroyed()) {
      win.webContents.send('vortexia:status', { connected: false, error: String(err) });
    }
    setTimeout(() => {
      if (!win.isDestroyed()) connectVortexia(name, win);
    }, 3000);
  }
}

async function fetchAgents() {
  try {
    const res = await fetch(`${REGISTRY_URL}/agents`);
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

// Same as fetchAgents, but null when the registry can't be reached at all —
// callers that must not mistake "backend not up yet" for "no agents".
async function fetchAgentsOrNull() {
  try {
    const res = await fetch(`${REGISTRY_URL}/agents`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// At login, macOS relaunches this app (Reopen Windows / login item) in the
// same second launchd starts the backend, so the registry is usually still
// booting when the bulk "open everything" path runs. A single fetch then
// returned {} and the app sat in the tray with no windows for the rest of
// the day — `las start` saw the process and reported "already running"
// (2026-09-23, after a reboot). Poll until the registry answers instead.
async function fetchAgentsWhenRegistryUp({ delayMs = 3000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const agents = await fetchAgentsOrNull();
    if (agents) {
      if (attempt > 1) log.info('startup', `registry ${REGISTRY_URL} reachable after ${attempt} attempts`);
      return agents;
    }
    if (attempt === 1 || attempt % 10 === 0) {
      log.warn('startup', `registry ${REGISTRY_URL} unreachable (attempt ${attempt}) — retrying every ${delayMs / 1000}s, no widgets until it answers`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

// ── initial agent(s) to open ─────────────────────────────────────────────────
// (resolveInitialAgentNames is defined above the single-instance-lock block,
// since userData scoping needs the agent name before that lock is requested.)

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  // Mic button (dictation) records via the renderer's MediaRecorder/
  // getUserMedia (transcription itself runs locally in this process — see
  // the "audio transcription" section above), which needs OS mic
  // permission. Electron prompts the OS itself on first getUserMedia call;
  // this just tells Chromium's renderer-facing permission gate to allow
  // 'media' requests through to that OS prompt instead of silently denying
  // them.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  createTray({ registryUrl: REGISTRY_URL, onSelectAgent: openWidget, onQuit: () => app.quit() });

  // System sleep/wake: the occlusion-expand/mosaic feature (see
  // the tile reconciler below) drives off document.visibilitychange,
  // which tracks real macOS window-occlusion notifications. Those go quiet for
  // the whole sleep duration, and a window that was already occluded going
  // into sleep gets no NEW occlusion notification on wake (same state as
  // before → no event) — so it can wake up stuck compact instead of
  // expanded/mosaic, even though it's still off-Space. Nudge every renderer to
  // re-read its actual visibilityState and re-apply immediately on resume,
  // instead of waiting on an occlusion event that may never re-fire.
  const resyncAllOcclusion = () => {
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('system:resume');
    }
  };
  powerMonitor.on('resume', resyncAllOcclusion);

  // Same class of bug as occlusion above, but for vortexia: connectVortexia's
  // retry chain is a chain of setTimeout(..., 3000)s, and Node timers don't
  // fire while the Mac is asleep — they queue up and fire in a burst on
  // wake, which is usually fine (confirmed live: a broker restart dropped
  // every widget's connection and they all reconnected together on the next
  // wake). But if a wake-time retry lands before the network/vortexia is
  // actually reachable, whatever's left of the chain up to that point can
  // go quiet — nothing schedules a NEW attempt beyond what was already
  // pending, so a client can just stay dead for the rest of the day
  // (confirmed live: DailyMonkey's connection died at 20:06 and never
  // recovered on its own, only fixed by manually restarting the app).
  // Same fix as above: force a fresh reconnect attempt on resume for any
  // window whose client is missing, plus a periodic sweep as insurance.
  const reconnectDeadVortexiaClients = () => {
    for (const [name, win] of windows) {
      if (win.isDestroyed()) continue;
      if (!vortexiaClients.has(name)) connectVortexia(name, win);
    }
  };
  powerMonitor.on('resume', reconnectDeadVortexiaClients);
  setInterval(reconnectDeadVortexiaClients, 5 * 60 * 1000);

  // Belt-and-suspenders beyond sleep/wake: sleep is the ONE case we can
  // detect and react to (powerMonitor above), but it's not the only way
  // macOS/Chromium's occlusion-notification delivery can go quiet — e.g.
  // rapid Space switching, Mission Control, or long idle stretches are all
  // unconfirmed but plausible ways the underlying push notifications could
  // silently stop arriving with no OS-level event this process gets to hook.
  // Rather than chase each one individually as it's reported, self-heal on a
  // timer: every few minutes, ask every renderer to re-read its OWN current
  // document.visibilityState (a live property, always accurate regardless of
  // whether the 'change' event fired) and re-apply. Cheap — a property read
  // per widget, a no-op when the applied state already matches (see
  // setOcclusionExpanded's early-return) — so this is pure insurance, not a
  // replacement for the event-driven paths above.
  setInterval(resyncAllOcclusion, 5 * 60 * 1000);

  // The tile reconciler's heartbeat (see "tile reconciler" above).
  setInterval(() => reconcileTiles(), TILE_TICK_MS);

  const explicit = resolveInitialAgentNames(process.argv);
  if (explicit) {
    // A specific agent was named (via --agent=/cwd .las-agent.json) — deliberate,
    // opens even if inactive, same as `las widget NAME` from that agent's own
    // folder.
    for (const name of explicit) openWidget(name);
  } else {
    // Bulk "open everything" (`las start`'s plain launch, no args): inactive
    // agents must stay put away here — only a deliberate `las widget NAME`/
    // `las agent activate`, or the vortexia wake-enabled fallback, should
    // bring one back. See main.js's set_inactive/`agent:deactivate` comments.
    const agents = await fetchAgentsWhenRegistryUp();
    for (const name of Object.keys(agents).sort()) {
      if (!agents[name].inactive) openWidget(name);
    }
  }
});

app.on('window-all-closed', () => {
  // Tray-resident app: stay alive with no windows open, same as the Swift
  // tray (agents can be reopened from the tray menu or via the protocol).
});

app.on('before-quit', async () => {
  for (const client of vortexiaClients.values()) {
    await client.close().catch(() => {});
  }
});
