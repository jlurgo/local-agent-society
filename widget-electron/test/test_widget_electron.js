'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function readSrc(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

/**
 * Strip //, /* *\/ comments and string literals are NOT stripped (we still
 * want to catch actual "osascript" calls inside strings) — this only removes
 * comment text so explanatory prose ("we deliberately avoid AppleScript")
 * doesn't trip source-scanning assertions.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function extractFunctionBody(src, needle) {
  const start = src.indexOf(needle);
  assert.notEqual(start, -1, `could not find "${needle}"`);
  let depth = 0;
  let bodyStart = -1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      if (depth === 0) bodyStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces after "${needle}"`);
}

/** Like extractFunctionBody, but returns the whole `function ...() {...}` text. */
function extractFunction(src, needle) {
  const start = src.indexOf(needle);
  assert.notEqual(start, -1, `could not find "${needle}"`);
  const body = extractFunctionBody(src, needle);
  return src.slice(start, src.indexOf(body, start) + body.length);
}

// ── single-instance lock ────────────────────────────────────────────────────

test('main.js requests the single-instance lock', () => {
  const src = readSrc('main.js');
  assert.match(src, /requestSingleInstanceLock\(\)/);
  assert.match(src, /app\.quit\(\)/, 'must quit when the lock is not obtained');
});

// ── reopen destroys-and-recreates ───────────────────────────────────────────

test('reopenWidget destroys the existing window before creating a new one', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'function reopenWidget(name)');
  const destroyPos = body.indexOf('.destroy()');
  const createPos = body.indexOf('createWidgetWindow(name');
  assert.notEqual(destroyPos, -1, 'reopenWidget must call .destroy() on the existing window');
  assert.notEqual(createPos, -1, 'reopenWidget must call createWidgetWindow(name, ...)');
  assert.ok(
    destroyPos < createPos,
    'destroy() must happen before createWidgetWindow so the old window is gone before the new one is made (matches the Swift reopen-not-focus fix)'
  );
});

test('openWidget does NOT destroy an existing window (that would defeat single-instance dedup)', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'function openWidget(name)');
  assert.doesNotMatch(body, /\.destroy\(\)/);
});

test('main.js claims the real localagentsociety:// scheme (post-cutover)', () => {
  const src = readSrc('main.js');
  const code = stripComments(src);
  assert.match(code, /PROTOCOL_SCHEME\s*=\s*['"`]localagentsociety['"`]/,
    'PROTOCOL_SCHEME must be the real scheme, not the pre-cutover -dev suffixed one');
  const devSchemeUsages = [...code.matchAll(/['"`]localagentsociety-dev['"`]/g)];
  assert.equal(devSchemeUsages.length, 0,
    'no code should reference the pre-cutover localagentsociety-dev scheme anymore');
});

// ── no IN-PROCESS Apple Events; spawned `osascript` is fine ─────────────────
//
// The historical incident this guards against was the retired Swift tray
// binary's IN-PROCESS NSAppleEventDescriptor calls losing their Apple Events
// TCC grant on every recompile (a code-signing identity problem specific to
// a compiled, frequently-rebuilt app bundle). Spawning the `osascript` CLI
// as a child process is a different mechanism: macOS attributes the
// automation permission to the stable `osascript` binary itself, not to
// this app, so rebuilding widget-electron never affects it — the backend
// (backend/main.py) has safely done exactly this all along for focus/
// terminal. So: ban NSAppleEventDescriptor (in-process) everywhere, and ban
// spawning `osascript` everywhere EXCEPT openTerminalAtPath's macOS branch
// in main.js, which is the one legitimate, reviewed use (a NEW Ghostty/iTerm2
// window at the agent's folder, for the "Open" button).

test('no in-process Apple Events anywhere in the app source', () => {
  const dirs = ['.', 'renderer', 'lib'];
  const offenders = [];
  for (const dir of dirs) {
    const abs = path.join(ROOT, dir);
    for (const entry of fs.readdirSync(abs)) {
      if (!/\.(js|html|css)$/.test(entry)) continue;
      const full = path.join(abs, entry);
      const content = stripComments(fs.readFileSync(full, 'utf8'));
      if (/NSAppleEventDescriptor/i.test(content)) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  }
  assert.deepEqual(offenders, [], `found in-process Apple Events usage in: ${offenders.join(', ')}`);
});

test('osascript is only spawned from runOsascript in main.js, nowhere else', () => {
  const dirs = ['.', 'renderer', 'lib'];
  const offenders = [];
  for (const dir of dirs) {
    const abs = path.join(ROOT, dir);
    for (const entry of fs.readdirSync(abs)) {
      if (!/\.(js|html|css)$/.test(entry)) continue;
      const full = path.join(abs, entry);
      if (full === path.join(ROOT, 'main.js')) continue; // checked separately below
      const content = stripComments(fs.readFileSync(full, 'utf8'));
      if (/osascript|AppleScript/i.test(content)) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  }
  assert.deepEqual(offenders, [], `found unexpected osascript/AppleScript references in: ${offenders.join(', ')}`);

  const mainSrc = stripComments(readSrc('main.js'));
  const body = extractFunctionBody(readSrc('main.js'), "function runOsascript(script, args = [])");
  assert.match(stripComments(body), /execFile\('osascript'/, 'runOsascript spawns the osascript CLI');
  const spawns = [...mainSrc.matchAll(/['"]osascript['"]/g)].length;
  assert.equal(spawns, 1, 'osascript must only be spawned inside runOsascript');
});

test('the children menu finds and closes a session through the backend, with the beacon passed as argv', () => {
  const mainSrc = readSrc('main.js');
  assert.match(mainSrc, /ipcMain\.handle\('agent:session-find'[\s\S]*?\/beacon`/);
  assert.match(mainSrc, /ipcMain\.handle\('agent:session-close'[\s\S]*?\/close`/);
  assert.match(mainSrc, /runOsascript\(GHOSTTY_FOCUS_TITLE_SCRIPT, \[json\.beacon\]\)/,
    'the beacon is an argument, never interpolated into the script');
  const widgetSrc = readSrc('renderer/widget.js');
  assert.match(widgetSrc, /if \(row\.sid\) el\.append\(\.\.\.sessionActionButtons\(row\.sid\)\)/,
    'only session rows (not default/all) get find/close');
  assert.doesNotMatch(stripComments(widgetSrc), /\bconfirm\(/, 'close confirms with a second click, never a blocking dialog');
});

// ── voice-selection hashing ──────────────────────────────────────────────────

const { hashString, hashIndex, pickVoice } = require('../lib/voiceHash');

test('hashString is a pure deterministic function of its input', () => {
  assert.equal(hashString('Alpha'), hashString('Alpha'));
  assert.notEqual(hashString('Alpha'), hashString('Beta'));
});

test('pickVoice is deterministic for a given agent name + locale + voice list', () => {
  const voices = [
    { name: 'V1', lang: 'en-US' },
    { name: 'V2', lang: 'en-GB' },
    { name: 'V3', lang: 'es-MX' },
  ];
  const a = pickVoice('AgentSmith', 'en-US', voices);
  const b = pickVoice('AgentSmith', 'en-US', voices);
  assert.deepEqual(a, b);
  assert.notEqual(a.voice, null);
  assert.match(a.voice.lang, /^en/);
});

test('pickVoice filters by language prefix, ignoring region', () => {
  const voices = [
    { name: 'EnUS', lang: 'en-US' },
    { name: 'EsMX', lang: 'es-MX' },
    { name: 'EsES', lang: 'es-ES' },
  ];
  const { voice } = pickVoice('Bot', 'es-ES', voices);
  assert.match(voice.lang, /^es/);
});

test('pickVoice falls back gracefully with a warning when no voice matches the locale', () => {
  const voices = [{ name: 'OnlyFrench', lang: 'fr-FR' }];
  const { voice, warning } = pickVoice('Bot', 'en-US', voices);
  assert.notEqual(voice, null);
  assert.match(warning, /falling back/i);
});

test('pickVoice handles an empty voice list without throwing', () => {
  const { voice, warning } = pickVoice('Bot', 'en-US', []);
  assert.equal(voice, null);
  assert.match(warning, /no voices/i);
});

test('hashIndex is stable across repeated calls and within bounds', () => {
  const list = ['a', 'b', 'c', 'd'];
  const idx = hashIndex('SomeAgentName', list);
  assert.equal(idx, hashIndex('SomeAgentName', list));
  assert.ok(idx >= 0 && idx < list.length);
});

// ── widget/ (Swift) retired ──────────────────────────────────────────────────
// The native Swift widget was deleted after this Electron app reached full
// parity with `las start`/`las widget`/`las stop` (see swift-widget-final git
// tag for the retired source, if it's ever needed again).

test('widget/ (Swift) has been removed — this Electron app is the sole widget', () => {
  const swiftDir = path.join(ROOT, '..', 'widget');
  assert.ok(!fs.existsSync(swiftDir));
});

// ── face buttons (restored from widget/tray.swift) ──────────────────────────

test('index.html renders all 6 face buttons (gear + 5, "open" in the retired palette\'s slot, "children" in the retired focus/scope slot)', () => {
  const html = readSrc('renderer', 'index.html');
  for (const id of ['gear', 'clear', 'open', 'speaker', 'mic', 'children']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing button #${id}`);
  }
});

test('the focus/scope button and its TTY picker are gone from every layer (delivery is vortexia, not a TTY)', () => {
  assert.doesNotMatch(readSrc('renderer', 'index.html'), /id="focus"|ttyPicker|ttyList/);
  const widget = stripComments(readSrc('renderer', 'widget.js'));
  assert.doesNotMatch(widget, /focusAgent|getAgentTtys|pinTty|openTtyPicker/);
  const preload = stripComments(readSrc('preload.js'));
  assert.doesNotMatch(preload, /focusAgent|getAgentTtys|pinTty|agent:focus|agent:ttys|agent:pin-tty/);
  const main = stripComments(readSrc('main.js'));
  assert.doesNotMatch(main, /agent:focus|agent:ttys|agent:pin-tty/);
  assert.match(main, /agent:tty-write/, 'the Clear button\'s raw "/clear" write stays');
});

test('preload.js exposes the face-button bridge methods on window.las', () => {
  const src = readSrc('preload.js');
  for (const method of [
    'getAgentInfo',
    'vortexiaSend',
    'sendToSelf',
    'openAgent',
    'getDefaultTerminalApp',
    'getAgentSessions',
    'getAgentConfig',
    'setSessionsConfig',
  ]) {
    assert.match(src, new RegExp(`${method}\\s*:`), `preload.js missing window.las.${method}`);
  }
});

test('speaker button toggles the existing mute pref (no new pref key)', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, "speakerEl.addEventListener('click', async () => {");
  assert.match(body, /persist\(\s*\{\s*mute:\s*!prefs\.mute\s*\}\s*\)/);
});

test('mic dictation publishes via vortexia (sendToSelf), not a direct live write into the linked terminal', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'async function stopRecordingAndTranscribe()');
  assert.match(body, /window\.las\.sendToSelf\(agentName,\s*result\.text\)/,
    'mic result must be sent via sendToSelf — direct terminal injection (writeToTty) is iTerm2/AppleScript-specific and not portable, explicitly rejected for dictation in favor of vortexia');
  assert.doesNotMatch(body, /window\.las\.writeToTty/,
    'mic must NOT use writeToTty — that stays reserved for the Clear button\'s "/clear", a different use case (act on a live session now vs. queue for next session start)');
});

test('mic dictation does not double-log: sendToSelf loops back via the agent\'s own vortexia subscription instead of appending locally', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'async function stopRecordingAndTranscribe()');
  assert.doesNotMatch(body, /appendLogEntry\(/,
    'must not appendLogEntry directly here — sendToSelf publishes to this agent\'s own inbox topic, which this widget is also subscribed to, so the message loops back through onVortexiaMessage and displays itself; appending it here too would double it');
});

// ── mic dictation: local Whisper transcription (replaces the broken ────────
// Electron SpeechRecognition/webkitSpeechRecognition — see main.js's "audio
// transcription" section and widget.js's mic section for the full writeup.
// webkitSpeechRecognition is a cloud API tied to a Google key only official
// Chrome builds have; it cannot work in Electron under any configuration.

test('mic dictation no longer USES the broken SpeechRecognition/webkitSpeechRecognition API (comments explaining why it was replaced are fine)', () => {
  const src = stripComments(readSrc('renderer', 'widget.js'));
  assert.doesNotMatch(src, /webkitSpeechRecognition|window\.SpeechRecognition\b/,
    'SpeechRecognition has no working backend in Electron and must not be used');
});

test('main.js exposes a local Whisper transcription IPC handler (audio:transcribe)', () => {
  const src = readSrc('main.js');
  assert.match(src, /ipcMain\.handle\('audio:transcribe'/);
  assert.match(src, /@xenova\/transformers/, 'expected the local Whisper library to be imported');
  assert.match(src, /automatic-speech-recognition/, 'expected the ASR pipeline task name');
});

test('preload.js bridges transcribeAudio and onAudioStatus for the mic\'s local-Whisper pipeline', () => {
  const src = readSrc('preload.js');
  assert.match(src, /transcribeAudio\s*:/);
  assert.match(src, /onAudioStatus\s*:/);
});

test('mic recording uses MediaRecorder (still real getUserMedia audio capture, only transcription moved local)', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /getUserMedia\(/);
  assert.match(src, /new MediaRecorder\(/);
});

test('mic sends recorded audio to transcribeAudio and routes text through the same sendToSelf pipeline as before', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'async function stopRecordingAndTranscribe()');
  assert.match(body, /window\.las\.transcribeAudio\(/);
  assert.match(body, /result\.ok\s*&&\s*result\.text/);
});

test('mic button has a distinct busy/transcribing visual state, separate from the recording (active) state', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, "function setMicState(next) {");
  assert.match(body, /classList\.toggle\('active',\s*next === 'listening'\)/);
  assert.match(body, /classList\.toggle\('busy',\s*next === 'transcribing'\)/);
});

test('mic recording has a max-duration safety net so a forgotten click-to-stop does not record forever', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /MAX_RECORDING_MS/);
  assert.match(src, /maxDurationTimer = setTimeout\(\(\) => \{[\s\S]*?stopRecordingAndTranscribe\(\);[\s\S]*?\}, MAX_RECORDING_MS\);/);
});

test('mic recording schedules countdown beeps (halfway/10s/5s) before the max-duration cutoff, cleared on manual stop', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /scheduleCountdownBeeps/);
  assert.match(src, /MAX_RECORDING_MS \/ 2/);
  assert.match(src, /MAX_RECORDING_MS - 10000/);
  assert.match(src, /MAX_RECORDING_MS - 5000/);
  assert.doesNotMatch(src, /MAX_RECORDING_MS - 2000/);
  const stopBody = extractFunctionBody(src, 'async function stopRecordingAndTranscribe() {');
  assert.match(stopBody, /clearCountdownTimers\(\)/);
});

test('double-clicking the mic runs a self-test (not a real recording), shows a floating toast, and on success pings its OWN inbox via sendToSelf (not a hardcoded TTS reply)', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /micEl\.addEventListener\('dblclick', \(\) => \{/);
  const testBody = extractFunctionBody(src, 'async function runMicSelfTest() {');
  assert.match(testBody, /getUserMedia/);
  assert.match(testBody, /showMicToast\('👍'\)/);
  assert.match(testBody, /window\.las\.sendToSelf\(agentName, MIC_SELFTEST_PING\)/);
  assert.doesNotMatch(src, /speakSelfTestOk/, 'the old hardcoded-TTS self-test path must be fully removed');
});

test('the mic self-test ping is a recognizable sentinel string a live session can pattern-match on to reply "OK"', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /const MIC_SELFTEST_PING = '\[las-mic-selftest\]/);
});

test('mic self-test waits for the actual "OK" reply before showing thumbs-up — mic capture alone only gets a neutral toast, not 👍', () => {
  const src = readSrc('renderer', 'widget.js');
  const testBody = extractFunctionBody(src, 'async function runMicSelfTest() {');
  // The success path must publish the ping, await a reply, and only THEN
  // show 👍 — not flash 👍 synchronously off of mic capture succeeding.
  assert.match(testBody, /showMicToast\('🎙️'\)/, 'capture-only feedback must not be the thumbs-up emoji');
  assert.match(testBody, /await window\.las\.sendToSelf\(agentName, MIC_SELFTEST_PING\)/);
  assert.match(testBody, /await waitForMicSelfTestReply\(MIC_SELFTEST_REPLY_TIMEOUT_MS\)/);
  // showMicToast('👍') must appear strictly after the await for the reply,
  // not before it (guards against reintroducing the old fire-and-forget bug).
  const sendIdx = testBody.indexOf('await window.las.sendToSelf(agentName, MIC_SELFTEST_PING)');
  const thumbsUpIdx = testBody.indexOf("showMicToast('👍')");
  assert.ok(sendIdx >= 0 && thumbsUpIdx >= 0 && thumbsUpIdx > sendIdx);
});

test('mic self-test shows thumbs-down (not thumbs-up) when no live session replies within the timeout', () => {
  const src = readSrc('renderer', 'widget.js');
  const testBody = extractFunctionBody(src, 'async function runMicSelfTest() {');
  assert.match(testBody, /if \(replied\) \{[\s\S]*?showMicToast\('👍'\);[\s\S]*?\} else \{[\s\S]*?showMicToast\('👎'\);/);
});

test('a mic-selftest-pong envelope resolves the pending self-test silently — no speak(), no appendLogEntry, no TTS — distinct from the audible "OK" speak-kind path', () => {
  const src = readSrc('renderer', 'widget.js');
  const handlerBody = extractFunctionBody(src, "window.las.onVortexiaMessage((envelope) => {");
  const pongMatch = handlerBody.match(/if \(envelope && envelope\.kind === 'mic-selftest-pong'\) \{([\s\S]*?)\n  \}\n  if \(envelope && envelope\.kind === 'speak'\)/);
  assert.ok(pongMatch, 'mic-selftest-pong branch must come before the speak-kind branch');
  const pongBranch = pongMatch[1];
  assert.doesNotMatch(pongBranch, /speak\(/, 'the silent mechanical pong must never trigger TTS');
  assert.doesNotMatch(pongBranch, /appendLogEntry/, 'the silent mechanical pong must not show a chat bubble');
  assert.match(pongBranch, /pendingMicSelfTestResolve\(true\)/);
});

test('waitForMicSelfTestReply resolves via a live-session "OK" speak-envelope reply, and stale timeouts from an overlapping earlier call cannot swallow a still-pending resolver', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /let pendingMicSelfTestResolve = null;/);
  assert.match(src, /envelope\.text\.trim\(\)\.toLowerCase\(\) === 'ok'/);
  const waitBody = extractFunctionBody(src, 'function waitForMicSelfTestReply(timeoutMs) {');
  assert.match(waitBody, /micSelfTestGeneration/, 'must guard against an overlapping earlier self-test\'s timeout nulling a newer pending resolver');
});

test('preload/main.js no longer expose the old speak-selftest-ok IPC channel (replaced by a real inbox ping)', () => {
  const preloadSrc = readSrc('preload.js');
  const mainSrc = readSrc('main.js');
  assert.doesNotMatch(preloadSrc, /speak-selftest-ok/);
  assert.doesNotMatch(mainSrc, /speak-selftest-ok/);
});

test('main.js vortexia:send handler resolves the sending agent from the window map (reuses the existing per-window VortexiaClient)', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, "ipcMain.handle('vortexia:send', async (event, toName, text) => {");
  assert.match(body, /nameForWindow\(win\)/);
  assert.match(body, /vortexiaClients\.get\(fromName\)/);
});

test('main.js never opens a second vortexia connection for face-button sends (no new VortexiaClient construction outside connectVortexia)', () => {
  const src = readSrc('main.js');
  const matches = [...src.matchAll(/new VortexiaClient\(/g)];
  assert.equal(matches.length, 1, 'expected exactly one `new VortexiaClient(` call site (inside connectVortexia)');
});

// ── "Open" button (replaced the command palette) ────────────────────────────

test('command palette is gone: no saved-command store, overlays or bridge methods remain', () => {
  const main = stripComments(readSrc('main.js'));
  const preload = stripComments(readSrc('preload.js'));
  const html = readSrc('renderer', 'index.html');
  const widget = stripComments(readSrc('renderer', 'widget.js'));
  for (const needle of ["'commands:get'", "'commands:set'", "'terminal:open'", 'function getCommands', 'function setCommands']) {
    assert.ok(!main.includes(needle), `main.js still has ${needle}`);
  }
  for (const needle of ['getCommands', 'setCommands', 'openTerminal:']) {
    assert.ok(!preload.includes(needle), `preload.js still exposes ${needle}`);
  }
  for (const needle of ['id="commands"', 'id="commandEdit"', 'id="terminal"']) {
    assert.ok(!html.includes(needle), `index.html still has ${needle}`);
  }
  for (const needle of ['renderCommandsList', 'openCommandEdit', 'window.las.getCommands', 'window.las.openTerminal(']) {
    assert.ok(!widget.includes(needle), `widget.js still has ${needle}`);
  }
});

test('DEFAULT_PREFS.openOrder defaults to terminal first, then folder', () => {
  const body = extractFunctionBody(readSrc('main.js'), 'const DEFAULT_PREFS = {');
  assert.match(body, /openOrder:\s*\['terminal',\s*'folder'\]/);
});

test('agent:open resolves the folder from the backend registry (never a typed cwd) and dispatches terminal / folder', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, "ipcMain.handle('agent:open', async (_event, name, action) => {");
  assert.match(body, /OPEN_ACTIONS\.includes\(action\)/, 'unknown actions must be rejected');
  assert.match(body, /await resolveAgentPath\(name\)/, 'the directory comes from the registry');
  assert.match(body, /shell\.openPath\(dir\)/, "'folder' reveals the directory via Electron's shell, no AppleScript");
  assert.match(body, /openTerminalAtPath\(dir\)/, "'terminal' opens a new terminal window at the directory");
  assert.doesNotMatch(body, /cwd/, 'no caller-supplied cwd is accepted');
  const resolver = extractFunctionBody(src, 'async function resolveAgentPath(name)');
  assert.match(resolver, /fetchAgents\(\)/);
  assert.match(resolver, /\.path/);
});

test('openTerminalAtPath opens a NEW WINDOW: Ghostty (preferred, via its scripting dictionary with an initial working directory), iTerm2 next, Terminal.app last', () => {
  const src = readSrc('main.js');
  assert.match(src, /TERMINAL_APP_CANDIDATES = \['Ghostty', 'iTerm', 'Terminal'\]/, 'Ghostty is this machine\'s default terminal; the rest are fallbacks in order');
  assert.match(src, /new window with configuration \{initial working directory:dir\}/, 'Ghostty must get a NEW WINDOW at the directory — `open -a Ghostty <dir>` only adds a tab to the frontmost window');
  const body = extractFunctionBody(src, 'function openTerminalAtPath(cwd) {');
  assert.match(body, /resolveTerminalApp\(\)/);
  assert.match(body, /GHOSTTY_NEW_WINDOW_SCRIPT/);
  assert.match(body, /ITERM_NEW_WINDOW_SCRIPT/);
  assert.match(body, /runOsascript\(script,\s*\[dir\]\)/, 'the directory is passed as an argv item, never interpolated into the script text');
  assert.match(body, /spawn\('open',\s*\['-a',\s*appName,\s*dir\]/, 'Terminal.app / custom apps open via `open -a <App> <dir>`');
  assert.doesNotMatch(src, /'-a',\s*'Ghostty'/, 'never `open -a Ghostty` (tab, not window)');
});

test('open button: a plain click runs the FIRST entry of the (sanitized) openOrder', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, "openEl.addEventListener('click', () => {");
  assert.match(body, /runOpenAction\(currentOpenOrder\(\)\[0\]\)/);
  assert.match(body, /openLongPressFired/, 'the release of a long press must not also fire the default action');
  const run = extractFunctionBody(src, 'async function runOpenAction(action)');
  assert.match(run, /window\.las\.openAgent\(agentName,\s*action\)/);
});

test('open button: press-and-hold (and right-click) shows the menu instead of running anything', () => {
  const src = readSrc('renderer', 'widget.js');
  const down = extractFunctionBody(src, "openEl.addEventListener('mousedown', (e) => {");
  assert.match(down, /setTimeout\(/);
  assert.match(down, /showOpenMenu\(\)/);
  assert.match(down, /OPEN_LONG_PRESS_MS/);
  assert.doesNotMatch(down, /runOpenAction/);
  assert.match(src, /openEl\.addEventListener\('mouseup',\s*cancelOpenLongPress\)/);
  assert.match(src, /openEl\.addEventListener\('mouseleave',\s*cancelOpenLongPress\)/);
  const ctx = extractFunctionBody(src, "openEl.addEventListener('contextmenu', (e) => {");
  assert.match(ctx, /e\.preventDefault\(\)/);
  assert.match(ctx, /showOpenMenu\(\)/);
});

test('open menu: rows can be moved up/down and the new order persists as the openOrder pref', () => {
  const src = readSrc('renderer', 'widget.js');
  const render = extractFunctionBody(src, 'function renderOpenMenu()');
  assert.match(render, /moveOpenAction\(index,\s*index - 1\)/);
  assert.match(render, /moveOpenAction\(index,\s*index \+ 1\)/);
  assert.match(render, /index === 0 \? ' default' : ''/, 'the top row is marked as the default');
  const move = extractFunctionBody(src, 'async function moveOpenAction(from, to)');
  assert.match(move, /persist\(\{\s*openOrder:\s*order\s*\}\)/);
});

test('currentOpenOrder sanitizes the pref: drops unknown entries, collapses duplicates, appends missing actions', () => {
  const src = readSrc('renderer', 'widget.js');
  const fn = extractFunction(src, 'function currentOpenOrder()');
  const run = (openOrder) => new Function('prefs', `const DEFAULT_OPEN_ORDER = ['terminal', 'folder']; ${fn}; return currentOpenOrder();`)({ openOrder });
  assert.deepEqual(run(undefined), ['terminal', 'folder'], 'no pref -> default order');
  assert.deepEqual(run(['folder', 'terminal']), ['folder', 'terminal'], 'a reordered pref is honored');
  assert.deepEqual(run(['folder']), ['folder', 'terminal'], 'a missing action is appended');
  assert.deepEqual(run(['bogus', 'folder', 'folder', 'terminal']), ['folder', 'terminal'], 'unknown + duplicate entries are cleaned');
  assert.deepEqual(run('garbage'), ['terminal', 'folder'], 'a non-array pref falls back to the default');
});

// ── auto-expand for overlay panels (settings) ──────────────────────────────

test('main.js exposes an idempotent window:set-expanded handler that remembers collapsed bounds', () => {
  const src = readSrc('main.js');
  assert.match(src, /ipcMain\.on\('window:set-expanded'/);
  assert.match(src, /collapsedBounds/);
  assert.match(src, /expandedWindows/);
});

test('preload.js exposes setExpanded on window.las', () => {
  const src = readSrc('preload.js');
  assert.match(src, /setExpanded\s*:/);
});

test('gear button toggles settings mode: the settings drawer opens/closes and the gear shows pressed', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /gearEl\.addEventListener\('click',\s*\(\)\s*=>\s*setSettingsOpen\(!settingsOpen\)\)/);
  const body = extractFunctionBody(src, 'function setSettingsOpen(open, fromDrawer = false) {');
  assert.match(body, /openDrawer\('settings'\)/);
  assert.match(body, /closeDrawer\('settings'\)/);
  assert.match(body, /gearEl\.classList\.toggle\('active', open\)/, "gear must visually show 'pressed' while settings is open");
});

// ── drawers: one inline panel below the buttons, the window grows DOWN ────
// Per explicit request: no popovers floating over the log (unreadable on a
// translucent face), no separate settings UI — settings, the Open menu and
// the children menu are the same kind of thing, a drawer under the button
// bar, and the widget resizes itself down to show it.

test('settings, Open and children are drawers of one controller; exactly one open at a time', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /registerDrawer\('settings',\s*settingsEl/);
  assert.match(src, /registerDrawer\('open',\s*openMenuEl/);
  assert.match(src, /registerDrawer\('children',\s*childrenMenuEl/);
  const open = extractFunctionBody(src, 'function openDrawer(name) {');
  assert.match(open, /activeDrawer && activeDrawer !== name/, 'opening one closes the other');
  assert.match(open, /compactHeight = window\.innerHeight/, 'remembers the compact height before the first drawer');
  assert.match(extractFunctionBody(src, 'async function showChildrenMenu()'), /openDrawer\('children'\)/);
  assert.match(extractFunctionBody(src, 'async function showOpenMenu()'), /openDrawer\('open'\)/);
  assert.match(extractFunctionBody(src, 'function closeChildrenMenu()'), /closeDrawer\('children'\)/);
  assert.match(extractFunctionBody(src, 'function closeOpenMenu()'), /closeDrawer\('open'\)/);
});

test('a drawer grows the window by its own measured height and shrinks it back on close; re-renders re-fit', () => {
  const src = readSrc('renderer', 'widget.js');
  const fit = extractFunctionBody(src, 'function fitWindowToDrawer() {');
  assert.match(fit, /window\.las\.setExpanded\(true,\s*compactHeight \+ el\.offsetHeight \+ DRAWER_GAP_PX\)/);
  const close = extractFunctionBody(src, 'function closeDrawer(name) {');
  assert.match(close, /window\.las\.setExpanded\(false\)/);
  assert.match(extractFunctionBody(src, 'async function moveOpenAction(from, to)'), /fitWindowToDrawer\(\)/, 'reordering re-renders the Open menu');
  assert.match(extractFunctionBody(src, 'async function showChildrenMenu()'), /fitWindowToDrawer\(\)/, 'the sessions list loads after the drawer opened');
  assert.doesNotMatch(stripComments(src), /SETTINGS_HEIGHT/, 'no fixed settings height any more — measured like every other drawer');
});

test('main.js grows the window down only (same x/y/width) and re-fits an already-expanded window', () => {
  const body = extractFunctionBody(readSrc('main.js'), "ipcMain.on('window:set-expanded', (event, expanded, height) => {");
  assert.match(body, /width: b\.width/, 'never changes the width');
  assert.doesNotMatch(body, /EXPANDED_WIDTH/);
  assert.match(body, /if \(expanded\) \{/, 'an expand while expanded re-fits instead of being ignored');
  assert.match(body, /if \(!expandedWindows\.has\(win\)\) \{\s*collapsedBounds\.set\(win, win\.getBounds\(\)\)/, 'compact bounds remembered once, on the first expand');
});

// ── packaging: the sibling vortexia checkout is a `file:` dependency, so
// `node_modules/vortexia` is a symlink to the WHOLE repo of a broker that is
// running while we build. Packing its live log (20MB and growing) and its
// mailbox snapshot shifted every asar data offset after them (seen twice on
// 2026-09-30: main.js began with the tail of another file, the app exited 1
// with no output). Its env file holds secrets, and its port file read from
// inside the asar would shadow the live port registry. Only src + package.json
// + its own node_modules belong in the bundle.

test('electron-builder never packs vortexia\'s live data, logs, secrets or port file', () => {
  const files = JSON.parse(readSrc('package.json')).build.files;
  assert.ok(files.some((f) => /^!node_modules\/vortexia\/\{[^}]*\blogs\b[^}]*\}\/\*\*\/\*$/.test(f)), 'logs/ excluded');
  assert.ok(files.some((f) => /^!node_modules\/vortexia\/\{[^}]*\bdata\b[^}]*\}\/\*\*\/\*$/.test(f)), 'data/ excluded');
  assert.ok(files.some((f) => f.startsWith('!node_modules/vortexia/{') && f.includes('vortexia.env') && f.includes('vortexia.port.json')), 'env + port file excluded');
});

test('no drawer is a popover or an overlay: menus and settings sit in normal flow below the button bar', () => {
  const css = readSrc('renderer', 'widget.css');
  const openMenu = css.slice(css.indexOf('.open-menu {'), css.indexOf('.open-menu.hidden'));
  assert.doesNotMatch(openMenu, /position:\s*fixed/);
  assert.match(openMenu, /position:\s*relative/);
  const settings = css.slice(css.indexOf('.settings {'), css.indexOf('.settings.hidden'));
  assert.doesNotMatch(settings, /position:\s*fixed|100vw|100vh/);
  assert.match(settings, /flex:\s*none/, 'natural height, so it can be measured');
});

test('window:set-expanded accepts an optional height override, falling back to EXPANDED_HEIGHT', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, "ipcMain.on('window:set-expanded', (event, expanded, height) => {");
  assert.match(body, /height\s*\|\|\s*EXPANDED_HEIGHT/);
});

// ── expand when hidden (retired Swift "Expand on space change") ────────────

test('growing makes the window click-through, shrinking restores the mouse; the panel-expand always wins', () => {
  const src = readSrc('main.js');
  assert.match(extractFunctionBody(src, 'function expandToTile(win, st) {'), /setIgnoreMouseEvents\(true/, 'grown face must be click-through: it can never block typing');
  assert.match(extractFunctionBody(src, 'function collapseFromTile(win, st) {'), /setIgnoreMouseEvents\(false\)/);
  assert.match(extractFunctionBody(src, 'function reconcileTiles(now = Date.now()) {'), /expandedWindows\.has\(win\)/, 'must not fight the settings/commands panel');
});

test('expandWhenHidden defaults to true, per explicit request (was off by default, matching the retired Prefs.expandOnSpaceChange default, until changed)', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'const DEFAULT_PREFS = {');
  assert.match(body, /expandWhenHidden:\s*true/);
});

test('visibilitychange handler is debounced and gated by the expandWhenHidden pref', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, "document.addEventListener('visibilitychange', () => {");
  assert.match(body, /setTimeout/, 'expected a debounce so brief occlusion flickers do not trigger a resize cycle');
  assert.match(body, /prefs\.expandWhenHidden/);
});

// ── dictation language is a user setting, independent of the agent's TTS voice ─

test('micLanguage defaults to Spanish and is NOT derived from the agent\'s TTS voice locale', () => {
  const mainSrc = readSrc('main.js');
  const body = extractFunctionBody(mainSrc, 'const DEFAULT_PREFS = {');
  assert.match(body, /micLanguage:\s*['"`]es['"`]/);

  const widgetSrc = readSrc('renderer', 'widget.js');
  assert.match(widgetSrc, /prefs\.micLanguage/, 'expected the mic pipeline to read prefs.micLanguage');
  assert.doesNotMatch(
    widgetSrc,
    /languageHint\s*=\s*\(locale/,
    'dictation language must not be derived from the agent\'s TTS locale — an agent can speak English while being dictated to in Spanish'
  );
});

test('index.html exposes a dictation-language picker defaulting to Spanish', () => {
  const html = readSrc('renderer', 'index.html');
  assert.match(html, /id="micLanguage"/);
  assert.match(html, /<option value="es">/);
});

test('user-msg (mic dictation) bubble always carries a "mic" description', () => {
  const src = readSrc('renderer', 'widget.js');
  const appendLogEntryIdx = src.indexOf('function appendLogEntry(envelope, { speak } = {}) {');
  const nextFnIdx = src.indexOf('\nfunction ', appendLogEntryIdx + 1);
  const body = src.slice(appendLogEntryIdx, nextFnIdx === -1 ? undefined : nextFnIdx);
  assert.match(body, /desc\.className = 'desc'/);
  assert.match(body, /desc\.textContent = 'mic'/);
  const css = readSrc('renderer', 'widget.css');
  assert.match(css, /\.log \.entry\.user-msg \.desc \{/);
});

test('local-msg (this agent\'s own voice) has a centered gradient accent segment on the bubble\'s TOP edge, half its width, no icon', () => {
  const css = readSrc('renderer', 'widget.css');
  assert.match(css, /\.log \.entry\.local-msg \.bubble::before \{[^}]*width:\s*50%/s);
  assert.match(css, /\.log \.entry\.local-msg \.bubble::before \{[^}]*left:\s*25%/s);
  assert.match(css, /\.log \.entry\.local-msg \.bubble::before \{[^}]*linear-gradient\(to right, transparent/s);
  assert.match(css, /\.log \.entry\.local-msg \.bubble \{[^}]*max-width:\s*92%/s);
  assert.doesNotMatch(css, /agent-icon/);
  const jsSrc = readSrc('renderer', 'widget.js');
  assert.doesNotMatch(jsSrc, /agent-icon/);
});

test('local-msg accent segment color is tied to the widget\'s own color (--local-accent), not the neutral --bubble-tint', () => {
  const jsSrc = readSrc('renderer', 'widget.js');
  assert.match(jsSrc, /--local-accent['"]?,\s*darkenHexToRgba\(color/);
  const css = readSrc('renderer', 'widget.css');
  assert.match(css, /\.log \.entry\.local-msg \.bubble::before \{[^}]*var\(--local-accent/s);
});

test('log entries have breathing room between bubbles (margin-bottom on .entry)', () => {
  const css = readSrc('renderer', 'widget.css');
  assert.match(css, /\.log \.entry \{[^}]*margin-bottom:\s*6px/s);
});

test('external-msg always renders a name chip tinted with the SENDER\'s own widget color (not this widget\'s), fetched via getPrefs', () => {
  const src = readSrc('renderer', 'widget.js');
  const appendLogEntryIdx = src.indexOf('function appendLogEntry(envelope, { speak } = {}) {');
  const nextFnIdx = src.indexOf('\nfunction ', appendLogEntryIdx + 1);
  const body = src.slice(appendLogEntryIdx, nextFnIdx === -1 ? undefined : nextFnIdx);
  assert.match(body, /chip\.className = 'from-chip'/);
  assert.match(body, /chip\.textContent = envelope\.from/);
  assert.match(body, /getAgentColor\(envelope\.from\)/);
  const css = readSrc('renderer', 'widget.css');
  assert.match(css, /\.log \.entry\.external-msg \.from-chip \{/);
});

test('user-msg and external-msg bubbles have no triangular tail — instead a square corner (pointing at their desc/chip) plus a radial gradient anchored there', () => {
  const css = readSrc('renderer', 'widget.css');
  assert.doesNotMatch(css, /clip-path:\s*polygon/, 'no more triangle clip-path tails');
  assert.match(css, /\.log \.entry\.user-msg \.bubble \{[^}]*border-radius:\s*12px 12px 0 12px/s);
  assert.match(css, /\.log \.entry\.external-msg \.bubble \{[^}]*border-radius:\s*12px 12px 12px 0/s);
  assert.match(css, /\.log \.entry\.user-msg \.bubble::after \{[^}]*radial-gradient\(circle at 100% 100%/s);
  assert.match(css, /\.log \.entry\.external-msg \.bubble::after \{[^}]*radial-gradient\(circle at 0% 100%/s);
});

test('external-msg name chip has a square top-left corner matching the bubble\'s square corner, sharing the same left inset (no extra margin)', () => {
  const css = readSrc('renderer', 'widget.css');
  assert.match(css, /\.log \.entry\.external-msg \.from-chip \{[^}]*border-radius:\s*0 999px 999px 999px/s);
  assert.doesNotMatch(css, /\.log \.entry\.external-msg \.from-chip \{[^}]*margin-left/s);
});

test('own dictation (self-send: from===to===agentName, source==="human") is labeled as the user, not the agent\'s own name', () => {
  // Not using extractFunctionBody here: appendLogEntry's own signature
  // contains braces in its destructured param ({ speak } = {}), which
  // confuses that helper's brace-balancing (it'd stop at the param's `{}`,
  // never reaching the real function body). Simple substring checks instead.
  const src = readSrc('renderer', 'widget.js');
  const appendLogEntryIdx = src.indexOf('function appendLogEntry(envelope, { speak } = {}) {');
  assert.notEqual(appendLogEntryIdx, -1, 'could not find appendLogEntry');
  const nextFnIdx = src.indexOf('\nfunction ', appendLogEntryIdx + 1);
  const body = src.slice(appendLogEntryIdx, nextFnIdx === -1 ? undefined : nextFnIdx);
  assert.match(body, /isOwnDictation/);
  assert.match(body, /source\s*===\s*['"`]human['"`]/);
});

// ── all face buttons in one bottom row (gear moved down on request) ────────

test('gear button lives inside .buttonbar, not floating separately at the top', () => {
  const html = readSrc('renderer', 'index.html');
  const barIdx = html.indexOf('class="buttonbar"');
  assert.notEqual(barIdx, -1, 'could not find .buttonbar');
  const barEndIdx = html.indexOf('</div>\n\n', barIdx); // buttonbar's closing div
  const barSection = html.slice(barIdx, barEndIdx === -1 ? undefined : barEndIdx);
  assert.match(barSection, /id="gear"/, 'gear button must be inside .buttonbar');
});

test('no CSS rule positions a face button absolutely at the top (all six sit in the bottom flex row)', () => {
  const css = readSrc('renderer', 'widget.css');
  assert.doesNotMatch(css, /^\.gear\s*\{/m, '.gear should no longer exist as a standalone top-positioned rule');
});

// ── backgroundThrottling:false so "expand when hidden" actually paints ─────

test('backgroundThrottling is NOT disabled unconditionally at window creation — it must stay on by default so occlusion detection keeps working', () => {
  // Confirmed live, twice: `backgroundThrottling: false` set unconditionally
  // in the BrowserWindow constructor DOES let a resize while occluded
  // actually paint — but it also stops document.visibilitychange from ever
  // firing 'hidden' at all (zero events across a real Space switch), since
  // Chromium's occlusion-based throttling and Page Visibility reporting
  // share the same underlying signal. Detection must stay on by default;
  // see the next test for the correct dynamic approach.
  const src = readSrc('main.js');
  const start = src.indexOf('function createWidgetWindow(name');
  assert.notEqual(start, -1, 'could not find createWidgetWindow');
  const end = src.indexOf('\nfunction ', start + 1);
  const body = src.slice(start, end === -1 ? undefined : end);
  assert.doesNotMatch(body, /webPreferences:\s*\{[^}]*backgroundThrottling:\s*false/s);
});

test('backgroundThrottling goes off only while grown (so the banner paints off-Space) and back on when shrinking', () => {
  const src = readSrc('main.js');
  assert.match(extractFunctionBody(src, 'function expandToTile(win, st) {'), /setBackgroundThrottling\(false\)/);
  assert.match(extractFunctionBody(src, 'function collapseFromTile(win, st) {'), /setBackgroundThrottling\(true\)/);
});

// ── mosaic tiling for multiple occlusion-expanded widgets on one display ───
// Ported from the retired Swift widget's AppDelegate.mosaicTiles/
// applyMosaicLayout (swift-widget-final tag, tray.swift) — without this,
// several widgets going occlusion-expanded on the same screen at once just
// stack exactly on top of each other instead of tiling.

test('mosaic grouping key is (display, macOS Space), not display alone — every widget on the machine sharing one physical display must not be lumped into a single giant grid', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'function mosaicKeyFor(win, spaceId = spaces.getSpaceForWindow(win)) {');
  assert.match(body, /`\$\{displayId\}:\$\{spaceId/, 'key must combine displayId with spaceId, not displayId alone');
});

test('mosaicTiles returns the full work area for 0 or 1 windows, and non-overlapping tiles otherwise', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'function mosaicTiles(count, workArea, seed = 0) {');
  const fn = new Function(`function mosaicTiles(count, workArea, seed = 0) ${body} return mosaicTiles;`)();
  const area = { x: 0, y: 0, width: 1000, height: 800 };

  assert.deepEqual(fn(0, area), []);
  assert.deepEqual(fn(1, area), [{ x: 0, y: 0, width: 1000, height: 800 }]);

  // 2, 3, and even counts >=4 (full 2xN grid) cover the work area exactly;
  // an odd count >=4 (e.g. 5 = 2 cols x 3 rows) leaves one grid cell empty,
  // same as the ported Swift layout.
  for (const count of [2, 3, 4, 5, 6]) {
    const tiles = fn(count, area);
    assert.equal(tiles.length, count, `expected ${count} tiles`);
    const totalArea = tiles.reduce((sum, t) => sum + t.width * t.height, 0);
    if (count < 4 || count % 2 === 0) {
      assert.ok(
        Math.abs(totalArea - area.width * area.height) < 1,
        `tiles for count=${count} should exactly cover the work area, got total ${totalArea}`
      );
    }
    for (const t of tiles) {
      assert.ok(t.x >= area.x && t.y >= area.y, `tile out of bounds for count=${count}`);
      assert.ok(t.x + t.width <= area.x + area.width + 0.01, `tile overflows width for count=${count}`);
      assert.ok(t.y + t.height <= area.y + area.height + 0.01, `tile overflows height for count=${count}`);
    }
  }
});

test('mosaicTiles is deterministic per seed and uses whole pixels that meet exactly', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'function mosaicTiles(count, workArea, seed = 0) {');
  const fn = new Function(`function mosaicTiles(count, workArea, seed = 0) ${body} return mosaicTiles;`)();
  const area = { x: 0, y: 25, width: 1511, height: 957 };
  for (const count of [2, 3, 4, 5, 7]) {
    for (const seed of [0, 1, 2, 3, 4, 17]) {
      assert.deepEqual(fn(count, area, seed), fn(count, area, seed), 'same group, same layout — a re-layout never reshuffles');
      for (const t of fn(count, area, seed)) {
        for (const k of ['x', 'y', 'width', 'height']) assert.ok(Number.isInteger(t[k]), `fractional ${k} for count=${count}`);
      }
    }
  }
});

// ── the tile reconciler, run for real against fake windows and Spaces ──────
// The section of main.js from mosaicTiles to the face buttons is evaluated
// with stand-ins for Electron (windows, screen, ipcMain), lib/spaces.js and
// the log, so the decisions below are the shipped code's, not a re-statement.

function loadReconciler() {
  const src = readSrc('main.js');
  const start = src.indexOf('function mosaicTiles(count, workArea, seed = 0) {');
  const end = src.indexOf('// ── face buttons: "Open"');
  const section = src.slice(start, end);
  const env = {
    windows: new Map(),
    spaceOf: new Map(),        // win -> space id (bigint) or null
    current: 1n,               // the Space the display shows
    logs: [],
    occlusionExpandedWindows: new Set(),
    collapsedBounds: new WeakMap(),
    expandedWindows: new WeakSet(),
  };
  const spaces = {
    getSpaceForWindow: (w) => (env.spaceOf.has(w) ? env.spaceOf.get(w) : null),
    getCurrentSpaceForWindow: () => env.current,
  };
  const screen = { getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1000, height: 800 } }) };
  const log = { info: (c, m) => env.logs.push(['info', m]), warn: (c, m) => env.logs.push(['warn', m]), error: (c, m) => env.logs.push(['error', m]) };
  const ipcMain = { on: () => {} };
  const fakeFs = { writeFileSync: () => {} };
  const make = new Function(
    'windows', 'spaces', 'screen', 'log', 'ipcMain', 'BrowserWindow', 'fs', 'path', 'SESSION_LOG_PATH',
    'occlusionExpandedWindows', 'collapsedBounds', 'expandedWindows', 'setTimeout',
    `${section}\nreturn { reconcileTiles, tileStateOf, mosaicTiles, applyTileSettings, tileSettings, TILE_EXPAND_SETTLE_MS, TILE_COLLAPSE_SETTLE_MS, TILE_FLAP_MAX, TILE_SETTINGS_LIMITS };`
  );
  const api = make(env.windows, spaces, screen, log, ipcMain, {}, fakeFs, path, '/tmp/widget.log',
    env.occlusionExpandedWindows, env.collapsedBounds, env.expandedWindows, () => 0);
  env.add = (name, space, { stubborn = false } = {}) => {
    let bounds = { x: 10, y: 10, width: 200, height: 120 };
    const win = {
      agentName: name,
      isDestroyed: () => false,
      isVisible: () => true,
      getBounds: () => ({ ...bounds }),
      setBounds: (b) => { if (!stubborn) bounds = { ...b }; },
      setIgnoreMouseEvents: () => {},
      webContents: { setBackgroundThrottling: () => {}, send: () => {} },
    };
    env.windows.set(name, win);
    env.spaceOf.set(win, space);
    return win;
  };
  return { ...api, env };
}

/** Run the reconciler across `ms` of fake time in heartbeat steps. */
function runFor(r, fromMs, ms, step = 500) {
  let t = fromMs;
  for (; t <= fromMs + ms; t += step) r.reconcileTiles(t);
  return t;
}

test('reconciler: a widget covered by another app on the CURRENT Space never grows (no Meet fight)', () => {
  const r = loadReconciler();
  const win = r.env.add('Wavi', 1n);                // on the Space being shown
  r.tileStateOf(win).reportedHidden = true;          // Chromium says "occluded" — Meet's window on top
  runFor(r, 0, 60 * 1000);
  assert.equal(r.env.occlusionExpandedWindows.has(win), false, 'covered on screen must stay compact');
  assert.equal(r.env.logs.filter(([, m]) => /grow|shrink/.test(m)).length, 0, 'not a single grow/shrink');
});

test('reconciler: every widget of an off-Space group gets its tile — late ones join the grid', () => {
  const r = loadReconciler();
  const a = r.env.add('bau', 2n);
  const b = r.env.add('coach', 2n);
  let t = runFor(r, 0, 5000);
  assert.ok(r.env.occlusionExpandedWindows.has(a) && r.env.occlusionExpandedWindows.has(b));
  assert.equal(a.getBounds().width * a.getBounds().height, 1000 * 800 / 2, 'two widgets: each a half of the screen (the seed picks the split)');
  // two more widgets show up on that Space later (stragglers)
  const c = r.env.add('billing', 2n);
  const d = r.env.add('dev-simulator', 2n);
  t = runFor(r, t, 5000);
  for (const w of [a, b, c, d]) {
    const bb = w.getBounds();
    assert.deepEqual([bb.width, bb.height], [500, 400], `${w.agentName} must fill its quarter of the screen, not stay small`);
  }
  const tiles = [a, b, c, d].map((w) => JSON.stringify(w.getBounds()));
  assert.equal(new Set(tiles).size, 4, 'four distinct tiles, no stacking');
});

test('reconciler: a quick swipe away and back (shorter than the settle time) changes nothing', () => {
  const r = loadReconciler();
  const win = r.env.add('Pulpo', 1n);
  runFor(r, 0, 3000);
  r.env.current = 9n;                                       // swipe to another Space...
  runFor(r, 3500, r.TILE_EXPAND_SETTLE_MS - 1000);
  r.env.current = 1n;                                       // ...and straight back
  runFor(r, 3500 + r.TILE_EXPAND_SETTLE_MS, 10 * 1000);
  assert.equal(r.env.logs.filter(([, m]) => /grow|shrink/.test(m)).length, 0, 'no grow/shrink pump on a glance');
});

test('reconciler: grows after the settle time off-Space, shrinks after coming back', () => {
  const r = loadReconciler();
  const win = r.env.add('DataLake', 1n);
  r.env.current = 5n;
  let t = runFor(r, 0, r.TILE_EXPAND_SETTLE_MS + 1000);
  assert.ok(r.env.occlusionExpandedWindows.has(win));
  assert.deepEqual(win.getBounds(), { x: 0, y: 0, width: 1000, height: 800 }, 'alone on its Space: the full work area');
  r.env.current = 1n;
  runFor(r, t, r.TILE_COLLAPSE_SETTLE_MS + 1000);
  assert.ok(!r.env.occlusionExpandedWindows.has(win));
  assert.deepEqual(win.getBounds(), { x: 10, y: 10, width: 200, height: 120 }, 'back to its compact place');
});

test('reconciler: a tile macOS does not apply is retried and reported in the log (audit)', () => {
  const r = loadReconciler();
  const win = r.env.add('Luganense', 2n, { stubborn: true });
  runFor(r, 0, 10 * 1000);
  assert.ok(r.env.logs.some(([lvl, m]) => lvl === 'warn' && /not on its tile/.test(m)), 'a miss is logged');
  assert.ok(r.env.logs.some(([lvl, m]) => lvl === 'error' && /still off its tile/.test(m)), 'a persistent miss escalates once');
});

test('reconciler: without Space info, an occlusion fight latches compact instead of pumping forever', () => {
  const r = loadReconciler();
  const win = r.env.add('Monkey', null);                  // CGS unavailable → visibility fallback
  const st = r.tileStateOf(win);
  let t = 0;
  let grows = 0;
  for (let i = 0; i < 20; i++) {                           // grow makes it visible, shrink makes it hidden...
    st.reportedHidden = !r.env.occlusionExpandedWindows.has(win);
    t = runFor(r, t, 4000);
  }
  grows = r.env.logs.filter(([, m]) => /: grow/.test(m)).length;
  assert.ok(grows <= r.TILE_FLAP_MAX, `grew ${grows} times in a fight — must latch after ${r.TILE_FLAP_MAX}`);
  assert.ok(r.env.logs.some(([lvl, m]) => lvl === 'warn' && /staying compact/.test(m)), 'the latch is logged');
});

test('reconciler: the shrink delay is a live setting — raising it holds the banner longer', () => {
  const r = loadReconciler();
  const win = r.env.add('Tortuga', 1n);
  r.applyTileSettings({ collapseSettleMs: 5000 });
  r.env.current = 7n;
  let t = runFor(r, 0, r.TILE_EXPAND_SETTLE_MS + 1000);
  assert.ok(r.env.occlusionExpandedWindows.has(win), 'grown off-Space');
  r.env.current = 1n;
  t = runFor(r, t, 4000);
  assert.ok(r.env.occlusionExpandedWindows.has(win), 'still big: the raised shrink delay has not elapsed');
  runFor(r, t, 2000);
  assert.ok(!r.env.occlusionExpandedWindows.has(win), 'shrinks once it has');
});

test('tile settings: a patch is clamped to the limits, garbage is ignored, unknown keys dropped', () => {
  const r = loadReconciler();
  assert.deepEqual(r.applyTileSettings(null), { tickMs: r.tileSettings.tickMs, collapseSettleMs: r.tileSettings.collapseSettleMs }, 'null patch: unchanged');
  const out = r.applyTileSettings({ tickMs: '50', collapseSettleMs: 99999, bogus: 1, nested: { tickMs: 1 } });
  assert.equal(out.tickMs, r.TILE_SETTINGS_LIMITS.tickMs[0], 'too-low heartbeat (as a string) clamps up');
  assert.equal(out.collapseSettleMs, r.TILE_SETTINGS_LIMITS.collapseSettleMs[1], 'too-high shrink delay clamps down');
  assert.ok(!('bogus' in out) && !('nested' in out), 'only the known keys come back');
  const again = r.applyTileSettings({ tickMs: 'abc', collapseSettleMs: NaN });
  assert.deepEqual(again, out, 'non-numbers leave the settings as they were');
  assert.equal(r.applyTileSettings({ collapseSettleMs: 749.6 }).collapseSettleMs, 750, 'rounded to whole ms');
});

// ── reopen (`las widget`) forgets saved position, keeps color/prefs ────────
// The saved-bounds restore is meant for a plain relaunch (`las start`); the
// explicit reopen command exists to grab a widget that is stuck or hard to
// find, so reappearing at the exact same spot would defeat the point.

test('reopenWidget passes forgetPosition so createWidgetWindow skips the saved bounds', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'function reopenWidget(name)');
  assert.match(body, /createWidgetWindow\(name,\s*\{\s*forgetPosition:\s*true\s*\}\)/);
});

test('createWidgetWindow only consults getSavedBounds when forgetPosition is false', () => {
  const src = readSrc('main.js');
  assert.match(src, /const saved = !forgetPosition && getSavedBounds\(name\);/);
});

test('openWidget (plain relaunch path) does not pass forgetPosition, so it keeps restoring the last position', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'function openWidget(name)');
  assert.match(body, /createWidgetWindow\(name\)\s*;/, 'openWidget should call createWidgetWindow(name) with no options, preserving saved-bounds restore');
});

// ── door button / `las agent deactivate` (close widget, mark inactive) ─────

test('handleProtocolUrl routes action=close to closeWidget, distinct from reopen/open', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'function handleProtocolUrl(rawUrl) {');
  assert.match(body, /action === 'close'/);
  assert.match(body, /closeWidget\(name\)/);
});

test('closeWidget destroys the existing window and does NOT recreate one', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'function closeWidget(name) {');
  assert.match(body, /\.destroy\(\)/);
  assert.doesNotMatch(body, /createWidgetWindow/, 'closeWidget must not reopen the widget — that would defeat "put it away"');
});

// ── `las agent rename` (an open widget window must follow the rename) ──────

test('handleProtocolUrl routes action=rename with a `to` param to renameWidget, distinct from close/reopen/open', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'function handleProtocolUrl(rawUrl) {');
  assert.match(body, /action === 'rename'/);
  assert.match(body, /renameWidget\(name,\s*to\)/);
});

test('renameWidget destroys the old-name window and creates one under the new name', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'function renameWidget(oldName, newName) {');
  assert.match(body, /windows\.get\(oldName\)/, 'must look up the window under the OLD name');
  assert.match(body, /\.destroy\(\)/);
  assert.match(body, /windows\.delete\(oldName\)/, 'must not leave a stale map entry under the old name');
  assert.match(body, /createWidgetWindow\(newName/, 'must open the replacement window under the NEW name');
});

test('renameWidget is a no-op when no window is open under the old name', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'function renameWidget(oldName, newName) {');
  assert.match(body, /if \(!existing \|\| existing\.isDestroyed\(\)\) return;/, 'a rename with nothing open for oldName must not create a window either — that\'s openWidget\'s job, not rename\'s');
});

test('agent:deactivate calls the backend inactive endpoint and destroys the calling window', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, "ipcMain.handle('agent:deactivate', async (event, name) => {");
  assert.match(body, /\/agents\/\$\{encodeURIComponent\(name\)\}\/inactive/, 'must POST to the inactive endpoint');
  assert.match(body, /method:\s*'POST'/);
  assert.match(body, /win\.destroy\(\)/, 'must destroy the window the request came from');
});

test('preload.js exposes deactivateAgent and the wake-enabled getter/setter', () => {
  const src = readSrc('preload.js');
  assert.match(src, /deactivateAgent\s*:/);
  assert.match(src, /setWakeEnabled\s*:/);
  assert.match(src, /getWakeEnabled\s*:/);
});

test('index.html has a door button and a wake-enabled settings checkbox', () => {
  const src = readSrc('renderer', 'index.html');
  assert.match(src, /id="door"/);
  assert.match(src, /id="wakeEnabled"/);
});

test('widget.js wires the door button to deactivateAgent and the wake checkbox to setWakeEnabled', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /doorEl\.addEventListener\('click'/);
  assert.match(src, /window\.las\.deactivateAgent\(agentName\)/);
  assert.match(src, /wakeEnabledEl\.addEventListener\('change'/);
  assert.match(src, /window\.las\.setWakeEnabled\(agentName,\s*wakeEnabledEl\.checked\)/);
});

// ── wake-enabled IPC handlers ────────────────────────────────────────────────

test('agent:set-wake-enabled toggles POST/DELETE on the wake-enabled endpoint based on the enabled flag', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, "ipcMain.handle('agent:set-wake-enabled', async (_event, name, enabled) => {");
  assert.match(body, /\/wake-enabled/);
  assert.match(body, /method:\s*enabled \? 'POST' : 'DELETE'/);
});

// ── name sizing/line-breaking (ported smartSplit/fitFontSizeAndSplit) ──────

test('smartSplit breaks at the space/hyphen closest to the middle, else the camelCase boundary closest to the middle, else leaves text alone', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'function smartSplit(text) {');
  const smartSplit = new Function(`function smartSplit(text) ${body} return smartSplit;`)();
  assert.equal(smartSplit('Minis App Acces'), 'Minis App\nAcces');
  assert.equal(smartSplit('LocalAgentSociety'), 'LocalAgent\nSociety');
  assert.equal(smartSplit('agentname'), 'agentname');
});

test('fitNameToBox shrinks the compact font from COMPACT_START_SIZE down to fit, and applies pre-line white-space only when split', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /const COMPACT_START_SIZE = 32;/);
  assert.match(src, /const COMPACT_MIN_SIZE = 13;/);
  const body = extractFunctionBody(src, 'function fitNameToBox() {');
  assert.match(body, /nameEl\.style\.whiteSpace = isSplit \? 'pre-line' : 'nowrap';/);
});

// ── hover reveal (cursor-depth-driven face) ─────────────────────────────────

test('#name is the SAME element in both states — no second/decorative title element in the markup', () => {
  const html = readSrc('renderer', 'index.html');
  assert.doesNotMatch(html, /nameRest/);
  assert.match(html, /<div id="name" class="name">/);
});

test('updateNameCenterOffset measures the actual rendered text width (canvas metrics), not #name\'s flex-stretched box width', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'function updateNameCenterOffset(size, text) {');
  assert.match(body, /measureTextWidth\(l, size\)/);
  assert.match(body, /nameEl\.offsetLeft/);
  assert.match(body, /nameEl\.offsetTop/);
  assert.doesNotMatch(body, /doorEl/, 'centers on the widget\'s own box, not the topbar minus the door button');
});

test('updateNameCenterOffset writes --name-cx/--name-cy/--name-origin-x, and fitNameToBox calls it (except for the occlusion-expanded banner)', () => {
  const src = readSrc('renderer', 'widget.js');
  const offsetBody = extractFunctionBody(src, 'function updateNameCenterOffset(size, text) {');
  assert.match(offsetBody, /--name-cx/);
  assert.match(offsetBody, /--name-cy/);
  assert.match(offsetBody, /--name-origin-x/);
  const fitBody = extractFunctionBody(src, 'function fitNameToBox() {');
  assert.match(fitBody, /if \(!expanded\) updateNameCenterOffset\(size, text\);/);
});

test('#name itself carries the hover-reveal transform (translate to widget center + scale up at rest) — one element, not a crossfade', () => {
  const css = readSrc('renderer', 'widget.css');
  const idx = css.indexOf('.name {');
  assert.notEqual(idx, -1);
  const block = css.slice(idx, css.indexOf('\n}\n', idx));
  assert.match(block, /transform-origin:\s*var\(--name-origin-x/);
  assert.match(block, /translate\(calc\(\(1 - var\(--reveal\)\) \* var\(--name-cx/);
  assert.match(block, /scale\(calc\(1 \+ \(1 - var\(--reveal\)\) \* 0\.15\)\)/);
  assert.match(block, /transition:\s*transform var\(--reveal-speed\)/);
});

test('.door-corner, .log and .buttonbar fade in with --reveal (the icons/conversation, not the title)', () => {
  const css = readSrc('renderer', 'widget.css');
  for (const selector of ['.door-corner {', '.log {', '.buttonbar {']) {
    const idx = css.indexOf(selector);
    assert.notEqual(idx, -1, `missing ${selector}`);
    const block = css.slice(idx, css.indexOf('}', idx));
    assert.match(block, /opacity:\s*var\(--reveal\)/, `${selector} must fade in with --reveal`);
    assert.match(block, /transition:[^;]*var\(--reveal-speed\)/, `${selector} must use the JS-controlled --reveal-speed, not a fixed duration`);
  }
});

test('invisible/faded-out door, log and buttonbar are non-interactive below the reveal threshold', () => {
  const css = readSrc('renderer', 'widget.css');
  assert.match(css, /\.widget:not\(\.reveal-interactive\) \.door-corner,\s*\n\.widget:not\(\.reveal-interactive\) \.log,\s*\n\.widget:not\(\.reveal-interactive\) \.buttonbar \{\s*\n\s*pointer-events:\s*none;/);
});

test('revealMarginPx reads the widget\'s own padding live (the "icon margin from the border") instead of a hardcoded constant', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'function revealMarginPx() {');
  assert.match(body, /getComputedStyle\(widgetEl\)/);
  assert.match(body, /paddingLeft/);
  assert.match(body, /paddingTop/);
});

test('setReveal caps tracking to REVEAL_TRACK_MS (not 0s) so even a fast entrance still animates a little, and uses the longer REVEAL_SETTLE_MS otherwise', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /const REVEAL_TRACK_MS = 70;/);
  // extractFunctionBody's brace counter can't be used here — the destructured
  // default parameter `{ settle } = {}` contains braces of its own before the
  // real function body starts, so this greps the body window directly.
  const start = src.indexOf('function setReveal(value, { settle } = {}) {');
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf('setReveal(0);', start));
  assert.match(body, /`\$\{settle \? REVEAL_SETTLE_MS : REVEAL_TRACK_MS\}ms`/);
});

test('mousemove only drives depth-tracking BEFORE the widget latches revealed — no live recomputation once inside', () => {
  const src = readSrc('renderer', 'widget.js');
  const idx = src.indexOf("widgetEl.addEventListener('mousemove'");
  assert.notEqual(idx, -1);
  const body = src.slice(idx, src.indexOf('});', idx) + 3);
  assert.match(body, /if \(revealed\) return;/, 'must bail out once latched, or hovering an icon near the border would recompute a shallow depth and collapse the face');
  assert.match(body, /Math\.min\(x, rect\.width - x, y, rect\.height - y\)/);
  assert.match(body, /trackEntrance\(depth \/ revealMarginPx\(\)\)/);
});

test('trackEntrance is a one-shot latch: --reveal follows depth only until it crosses 1, then "revealed" freezes it there for good', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'function trackEntrance(depthRatio) {');
  assert.match(body, /if \(revealed\) return;/);
  assert.match(body, /revealed = true;/);
  assert.match(body, /setReveal\(1, \{ settle: false \}\);/);
  assert.match(body, /setReveal\(depthRatio, \{ settle: false \}\);/);
});

test('mouseleave does not reset immediately — it arms a debounced timer, so grazing the border does not collapse the face', () => {
  const src = readSrc('renderer', 'widget.js');
  const idx = src.indexOf("widgetEl.addEventListener('mouseleave'");
  assert.notEqual(idx, -1);
  // The naive "first '});' after idx" landed inside setReveal(0, { settle:
  // true }) — that call's own closing also happens to read "});" — so this
  // anchors on the debounce's actual outer close instead.
  const endMarker = '}, REVEAL_LEAVE_DEBOUNCE_MS);\n});';
  const endIdx = src.indexOf(endMarker, idx);
  assert.notEqual(endIdx, -1);
  const body = src.slice(idx, endIdx + endMarker.length);
  assert.match(body, /leaveTimer = setTimeout\(\(\) => \{/);
  assert.match(body, /revealed = false;/);
  assert.match(body, /setReveal\(0, \{ settle: true \}\)/);
});

test('mouseleave ignores resize drags — dragging #resizeHandle moves the window via IPC with enough lag that the cursor briefly reads as outside widgetEl, which is not the user actually leaving', () => {
  const src = readSrc('renderer', 'widget.js');
  const idx = src.indexOf("widgetEl.addEventListener('mouseleave'");
  assert.notEqual(idx, -1);
  const body = src.slice(idx, src.indexOf('if (revealLocked()', idx) + 60);
  assert.match(body, /if \(revealLocked\(\) \|\| resizing\) return;/);
});

test('mousemove and mouseenter cancel a pending leave — re-entering before the debounce fires keeps the widget revealed', () => {
  const src = readSrc('renderer', 'widget.js');
  const mousemoveIdx = src.indexOf("widgetEl.addEventListener('mousemove'");
  const mousemoveBody = src.slice(mousemoveIdx, src.indexOf('});', mousemoveIdx) + 3);
  assert.match(mousemoveBody, /cancelPendingLeave\(\);/);

  const mouseenterIdx = src.indexOf("widgetEl.addEventListener('mouseenter'");
  assert.notEqual(mouseenterIdx, -1);
  const mouseenterBody = src.slice(mouseenterIdx, src.indexOf('});', mouseenterIdx) + 3);
  assert.match(mouseenterBody, /cancelPendingLeave\(\);/);

  const cancelBody = extractFunctionBody(src, 'function cancelPendingLeave() {');
  assert.match(cancelBody, /clearTimeout\(leaveTimer\)/);
});

test('reveal is locked (ignores mouse depth) while ANY drawer is open or the occlusion-expanded banner is active', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'function revealLocked() {');
  assert.match(body, /activeDrawer !== null/, 'settings, Open menu and children menu all lock it');
  assert.doesNotMatch(body, /settingsOpen/, 'no longer settings-only');
  assert.match(body, /occlusion-expanded/);
});

test('settings drawer uses the children/Open menu box: same padding, radius, border and row dividers', () => {
  const css = readSrc('renderer', 'widget.css');
  const block = (sel) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
  const menu = block('.open-menu');
  const settings = block('.settings');
  for (const prop of ['padding', 'border-radius', 'border']) {
    const re = new RegExp(`\\n\\s*${prop}:\\s*([^;]+);`);
    assert.equal(settings.match(re)?.[1], menu.match(re)?.[1], `${prop} matches .open-menu`);
  }
  assert.match(css, /\.settings-row \+ \.settings-row\s*\{\s*border-top:\s*1px solid rgba\(0, 0, 0, 0\.12\);/);
  assert.doesNotMatch(block('.settings-row'), /margin-bottom/);
});

test('opening any drawer forces a fully revealed, settled face and keeps the "revealed" latch in sync', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'function openDrawer(name) {');
  assert.match(body, /revealed = true;/);
  assert.match(body, /setReveal\(1, \{ settle: true \}\);/);
});

test('occlusion-expanded overrides switch off the hover-reveal transform on .name entirely, per its own always-centered banner styling', () => {
  const css = readSrc('renderer', 'widget.css');
  const idx = css.indexOf('.widget.occlusion-expanded .name {');
  assert.notEqual(idx, -1);
  const block = css.slice(idx, css.indexOf('}', idx));
  assert.match(block, /transform:\s*none/);
});

test('occlusion-expanded name fill is solid black with no text-stroke, per explicit request', () => {
  const src = readSrc('renderer', 'widget.css');
  const idx = src.indexOf('.widget.occlusion-expanded .name {');
  assert.notEqual(idx, -1);
  const block = src.slice(idx, src.indexOf('}', idx));
  assert.match(block, /color:\s*#000/);
  assert.match(block, /-webkit-text-stroke:\s*0/);
});

test('the door button always stays visible (both compact and settings-open) while every other face button hides in settings-open', () => {
  const css = readSrc('renderer', 'widget.css');
  assert.match(css, /\.widget\.settings-open \.buttonbar \.facebtn:not\(#gear\)\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(css, /\.widget\.settings-open[^{]*door[^{]*\{\s*display:\s*none/);
});

test('restore-after-visible delay is a single named constant, easy to retune to whatever value is currently set', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /const RESTORE_DELAY_MS = \d+;/, 'RESTORE_DELAY_MS must stay a bare numeric literal, not an expression, so it stays a one-line, easy-to-retune knob');
  const body = extractFunctionBody(src, "document.addEventListener('visibilitychange', () => {");
  assert.match(body, /hidden \? 400 : RESTORE_DELAY_MS/, 'hide path keeps its short flicker-guard debounce; the show path uses the configurable restore delay');
});

// ── inactive agents must NOT come back on a bulk/auto open ──────────────────
// `las start`'s plain launch (no args) hits the "open everything" branch;
// only a deliberate single-agent open (explicit --agent=/cwd .las-agent.json, or
// `las widget NAME`/wake-via-vortexia — neither goes through this branch)
// should ever open an inactive widget.

test('the bulk "open everything" startup branch skips agents marked inactive', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'app.whenReady().then(async () => {');
  const bulkBranch = body.slice(body.indexOf('} else {'));
  assert.match(bulkBranch, /if \(!agents\[name\]\.inactive\) openWidget\(name\);/);
});

test('visible and active are correlated: openWidget/reopenWidget both clear the inactive flag remotely on every deliberate single-agent open', () => {
  const src = readSrc('main.js');
  assert.match(
    readSrc('main.js'),
    /function clearInactiveRemote\(name\) \{[\s\S]*?method: 'DELETE'/,
    'clearInactiveRemote must DELETE the inactive flag'
  );
  const openBody = extractFunctionBody(src, 'function openWidget(name) {');
  const reopenBody = extractFunctionBody(src, 'function reopenWidget(name) {');
  assert.match(openBody, /clearInactiveRemote\(name\)/);
  assert.match(reopenBody, /clearInactiveRemote\(name\)/);
});

// ── local Kokoro TTS (replaces window.speechSynthesis) ──────────────────────

const { KOKORO_VOICES } = require('../lib/kokoroVoices');

test('KOKORO_VOICES only lists en-US/en-GB/es-ES voices, each with a unique name and a kokoroLang', () => {
  assert.ok(KOKORO_VOICES.length > 0);
  const names = new Set();
  for (const v of KOKORO_VOICES) {
    assert.match(v.lang, /^(en-US|en-GB|es-ES)$/, `unexpected lang "${v.lang}" for voice "${v.name}"`);
    assert.equal(typeof v.kokoroLang, 'string', `voice "${v.name}" must carry the kokoro-onnx lang code`);
    assert.equal(names.has(v.name), false, `duplicate voice name "${v.name}"`);
    names.add(v.name);
  }
});

test('every Spanish voice in KOKORO_VOICES maps to kokoroLang "es"', () => {
  const esVoices = KOKORO_VOICES.filter((v) => v.lang === 'es-ES');
  assert.ok(esVoices.length > 0, 'expected at least one Spanish voice');
  for (const v of esVoices) assert.equal(v.kokoroLang, 'es');
});

test('pickVoice resolves a real Kokoro voice id for an English-locale agent', () => {
  const { voice, warning } = pickVoice('SomeAgent', 'en-US', KOKORO_VOICES);
  assert.equal(warning, null);
  assert.ok(KOKORO_VOICES.some((v) => v.name === voice.name), 'resolved voice must come from the Kokoro pool');
});

test('preload.js exposes the Kokoro voice pool and synthesis bridge on window.las', () => {
  const src = readSrc('preload.js');
  assert.match(src, /ttsVoices:\s*KOKORO_VOICES/);
  assert.match(src, /synthesizeSpeech:\s*\(text, voiceId, lang\) => ipcRenderer\.invoke\('tts:synthesize', text, voiceId, lang\)/);
});

test('main.js exposes a tts:synthesize IPC handler that calls the backend, not in-process ONNX', () => {
  const src = readSrc('main.js');
  assert.match(src, /ipcMain\.handle\('tts:synthesize'/);
  const body = extractFunctionBody(src, 'async function synthesizeSpeech(text, voiceId, lang) {');
  assert.match(body, /\$\{REGISTRY_URL\}\/tts\/synthesize/, 'synthesis must go through the backend, not kokoro-js/onnxruntime-node in this process');
  assert.doesNotMatch(stripComments(readSrc('main.js')), /kokoro-js/, 'kokoro-js must not be loaded in the Electron process (packaging conflict with onnxruntime-node — see backend/main.py instead)');
});

test("widget.js's speak() no longer uses window.speechSynthesis (replaced by local Kokoro synthesis)", () => {
  const src = stripComments(readSrc('renderer', 'widget.js'));
  assert.doesNotMatch(src, /speechSynthesis/);
  assert.doesNotMatch(src, /SpeechSynthesisUtterance/);
});

test("widget.js's speak() synthesizes via window.las.synthesizeSpeech and plays back the returned WAV", () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'async function speak(text, envelope) {');
  assert.match(body, /window\.las\.pickVoice\(agentName, locale, window\.las\.ttsVoices\)/);
  assert.match(body, /window\.las\.synthesizeSpeech\(text, voice\.name, voice\.kokoroLang\)/);
  assert.match(body, /new Audio\(url\)/);
});

test("widget.js's speak() honours a Kokoro voice pinned via tts_voice before falling back to the name hash", () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /let ttsVoice = null;/);
  const initBody = extractFunctionBody(src, 'async function init() {');
  assert.match(initBody, /if \(info && info\.ttsVoice\) ttsVoice = info\.ttsVoice;/);
  const body = extractFunctionBody(src, 'async function speak(text, envelope) {');
  assert.match(body, /window\.las\.ttsVoices\.find\(\(v\) => v && v\.name === ttsVoice\)/);
  assert.match(body, /pinned \? \{ voice: pinned, warning: null \} : window\.las\.pickVoice\(agentName, locale, window\.las\.ttsVoices\)/);
  // An unknown id must not silently mute the agent — it warns and hashes as before.
  assert.match(body, /is not in the Kokoro pool/);
});

test("main.js's agent:info reads tts_voice from the agent's config view and returns it as ttsVoice", () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, 'async function fetchPinnedTtsVoice(name) {');
  assert.match(body, /\/agents\/\$\{encodeURIComponent\(name\)\}\/config/);
  assert.match(body, /view\.config\.tts_voice/);
  const info = src.slice(src.indexOf("ipcMain.handle('agent:info'"));
  assert.match(info, /const ttsVoice = await fetchPinnedTtsVoice\(name\);/);
  assert.match(info, /locale: data\.lang \|\| 'en-US', ttsVoice \}/);
});

test("widget.js's speak() still respects the mute pref before doing any synthesis work", () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'async function speak(text, envelope) {');
  const muteCheck = body.indexOf('if (prefs.mute) {');
  const synthCall = body.indexOf('window.las.synthesizeSpeech');
  assert.notEqual(muteCheck, -1);
  assert.ok(muteCheck < synthCall, 'mute must be checked before synthesis is attempted');
});

// ── children: which connected session hears the mic (docs/adr/0005) ────────
// The target is the AGENT's choice, in its .las-agent.json, applied by the
// backend — never a window pref, never decided in this app.

test('the mic target is not a window pref: DEFAULT_PREFS has no micTarget and the renderer never persists one', () => {
  const body = extractFunctionBody(readSrc('main.js'), 'const DEFAULT_PREFS = {');
  assert.doesNotMatch(body, /micTarget/);
  assert.doesNotMatch(stripComments(readSrc('renderer', 'widget.js')), /prefs\.micTarget|persist\(\{\s*micTarget/);
});

test('a dictation and the self-test are sent with NO target — the backend applies the agent\'s sessions.target', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /window\.las\.sendToSelf\(agentName,\s*result\.text\)/);
  assert.match(src, /window\.las\.sendToSelf\(agentName,\s*MIC_SELFTEST_PING\)/);
  assert.match(readSrc('preload.js'), /sendToSelf:\s*\(name,\s*text\)\s*=>\s*ipcRenderer\.invoke\('vortexia:send',\s*name,\s*text\)/);
});

test('vortexia:send goes through the backend /agents/send (source human, no session choice of its own) and falls back to a direct agent-inbox publish only when the backend is unreachable', () => {
  const body = extractFunctionBody(readSrc('main.js'), "ipcMain.handle('vortexia:send', async (event, toName, text) => {");
  assert.match(body, /\/agents\/send/);
  assert.match(body, /source: 'human'/);
  assert.doesNotMatch(body, /all_sessions|session: target/, 'the window never picks a session — that is the agent\'s sessions.target, read by the backend');
  const backendCall = body.indexOf('/agents/send');
  const direct = body.indexOf('client.sendConfirmed(toName, text');
  assert.ok(backendCall !== -1 && direct !== -1 && backendCall < direct, 'backend first, direct publish as the fallback');
  assert.match(body, /fallback_from/, 'reports when the configured target was not connected');
  assert.match(body, /reachedBackend/, 'any HTTP answer means the backend may have published: never republish');
  assert.match(body, /AbortSignal\.timeout\(SEND_TIMEOUT_MS\)/, 'a hung backend is bounded, and a timeout is an error, not a fallback');
});

test('agent:sessions reports an UNKNOWN policy (target: null) on failure and the renderer keeps its last known choice', () => {
  const body = extractFunctionBody(readSrc('main.js'), "ipcMain.handle('agent:sessions', async (_event, name) => {");
  assert.doesNotMatch(body, /target: 'default'/);
  assert.match(body, /target: null/);
  const refresh = extractFunctionBody(readSrc('renderer', 'widget.js'), 'async function refreshSessions()');
  assert.match(refresh, /typeof view\.target === 'string'/);
});

test('the children button lists the sessions on click, hold or right-click; a row writes sessions.target to .las-agent.json via the backend; no cc toggle in the menu (settings only)', () => {
  const src = readSrc('renderer', 'widget.js');
  const down = extractFunctionBody(src, "childrenEl.addEventListener('mousedown', (e) => {");
  assert.match(down, /showChildrenMenu\(\)/);
  assert.match(down, /OPEN_LONG_PRESS_MS/);
  assert.match(src, /childrenEl\.addEventListener\('contextmenu'/);
  const click = extractFunctionBody(src, "childrenEl.addEventListener('click', () => {");
  assert.match(click, /showChildrenMenu\(\)/);
  const render = extractFunctionBody(src, 'function renderChildrenMenu()');
  assert.match(render, /setSessionsConfig\(\{\s*target:\s*row\.value\s*\}\)/);
  assert.match(render, /targetRows\(\)/);
  const rows = extractFunctionBody(src, 'function targetRows()');
  assert.match(rows, /value: 'default'/);
  assert.match(rows, /value: 'all'/);
  assert.match(rows, /value: runtime/, 'a row per connected RUNTIME — the same vocabulary `las agent target shell` writes, stable across a terminal being reopened');
  assert.match(rows, /sessions\.length === 1/, 'a runtime row only when that runtime has a single session');
  assert.match(rows, /value: s\.sid/, 'several sessions of one runtime: one row each, by id');
  assert.doesNotMatch(rows, /\(\$\{sessions\.length\}\)/, 'no "codex (2)" group row — it read as one more session');
  assert.match(rows, /alias: i === 0 \? runtime/, 'a runtime target still lights up the session it resolves to');
  assert.match(extractFunctionBody(src, 'function syncMicTargetSelect()'), /targetRows\(\)/, 'the settings select shows the same rows');
  assert.doesNotMatch(render, /cc_default|Copy last-used/, 'the cc choice lives in settings, not in the children menu');
  const save = extractFunctionBody(src, 'async function setSessionsConfig(patch)');
  assert.match(save, /window\.las\.setSessionsConfig\(agentName,\s*patch\)/);
  const patch = extractFunctionBody(readSrc('main.js'), "ipcMain.handle('agent:config-sessions', async (_event, name, patch) => {");
  assert.match(patch, /method: 'PATCH'/);
  assert.match(patch, /\/config`/);
  assert.match(patch, /sessions: patch/);
});

test('the settings panel offers the same choice (Dictation goes to + Copy last-used session), bound to the same backend write', () => {
  const html = readSrc('renderer', 'index.html');
  assert.match(html, /id="micTarget"/);
  assert.match(html, /id="ccDefault"/);
  assert.match(html, /id="childrenMenu"/);
  assert.doesNotMatch(html, /id="micMenu"/);
  const src = readSrc('renderer', 'widget.js');
  assert.match(src, /micTargetEl\.addEventListener\('change',\s*\(\)\s*=>\s*setSessionsConfig\(\{\s*target:\s*micTargetEl\.value\s*\}\)\)/);
  assert.match(src, /ccDefaultEl\.addEventListener\('change',\s*\(\)\s*=>\s*setSessionsConfig\(\{\s*cc_default:\s*ccDefaultEl\.checked\s*\}\)\)/);
});

test('the mic button itself has no press-and-hold menu any more — click toggles recording, double-click self-tests, nothing else', () => {
  const src = stripComments(readSrc('renderer', 'widget.js'));
  assert.doesNotMatch(src, /micEl\.addEventListener\('(mousedown|contextmenu|mouseup|mouseleave)'/);
  assert.match(src, /micEl\.addEventListener\('click'/);
  assert.match(src, /micEl\.addEventListener\('dblclick'/);
});

test('session-targeted messages show in the log (viewer subscription to the session inboxes) and cc copies do not', () => {
  const main = extractFunctionBody(readSrc('main.js'), 'async function connectVortexia(name, win) {');
  assert.match(main, /client\.mqttClient\.subscribe\(`las\/agent\/\$\{name\}\/sessions\/\+\/inbox`/);
  const handler = extractFunctionBody(readSrc('renderer', 'widget.js'), 'window.las.onVortexiaMessage((envelope) => {');
  assert.match(handler, /envelope\.kind === 'cc'/);
  const ccBranch = handler.slice(handler.indexOf("envelope.kind === 'cc'"));
  assert.ok(ccBranch.indexOf('return;') < ccBranch.indexOf('appendLogEntry('), 'a cc copy returns before any appendLogEntry');
});

// ── speak-queue handshake: never two agents talking at once ────────────────
// The backend drainer (backend/main.py's _drain_one) publishes ONE speak
// envelope and blocks until the widget that plays it acks 'done'/'skipped'.
// Playback lives in this app, so the ack has to come from here — if any of
// these regress, the queue silently degrades back to publish-as-fast-as-
// you-can and overlapping voices (heard live 2026-09-28).

test('preload.js exposes ackSpeak for the speak-queue handshake', () => {
  const src = readSrc('preload.js');
  assert.match(src, /ackSpeak:\s*\(id,\s*phase,\s*reason,\s*durationMs\)\s*=>\s*ipcRenderer\.invoke\('queue:ack',\s*id,\s*phase,\s*reason,\s*durationMs\)/);
});

test('renderer asks the speaker lock before playing and drops a refused clip (2026-10-14: four voices at once)', () => {
  const src = readSrc('renderer/widget.js');
  const body = extractFunctionBody(src, 'async function speak(');
  const gate = body.indexOf('mayPlay(envelope');
  assert.ok(gate > 0, 'speak() must ask mayPlay before playing');
  assert.ok(gate < body.indexOf('audioEl.play()'), 'the lock is asked BEFORE the audio starts');
  const mayPlay = extractFunctionBody(src, 'async function mayPlay(');
  assert.match(mayPlay, /'playing'/);
  assert.match(mayPlay, /known === false/, 'a refusal (known:false) means: do not play');
});

test('renderer plays a redelivered speak envelope (same id) only once', () => {
  const src = readSrc('renderer/widget.js');
  assert.match(src, /if \(!firstTimeSeen\(envelope\)\) return;/);
});

test('main.js forwards queue:ack to the backend as POST /queue/ack', () => {
  const src = readSrc('main.js');
  const body = extractFunctionBody(src, "ipcMain.handle('queue:ack'");
  assert.match(body, /\/queue\/ack/);
  assert.match(body, /method:\s*'POST'/);
  assert.match(body, /JSON\.stringify\(\{\s*id,\s*phase,\s*reason/);
});

test('widget.js claims a speak envelope on receipt (started) and plays it through the local chain', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'window.las.onVortexiaMessage((envelope) => {');
  const speakBranch = body.slice(body.indexOf("envelope.kind === 'speak'"));
  assert.match(speakBranch, /ackSpeak\(envelope,\s*'started'\)/,
    "'started' must go back on receipt — the drainer only waits a short grace for someone to claim a clip");
  assert.match(speakBranch, /enqueueSpeak\(envelope\.text \|\| '',\s*envelope\)/);
  assert.doesNotMatch(speakBranch, /[^a-zA-Z]speak\(envelope\.text/,
    'must go through enqueueSpeak (the per-widget chain), not straight to speak()');
});

test('widget.js speak() acks done after playback ends and skipped on every path that never plays', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'async function speak(text, envelope)');
  // Playback paths go through finish(phase, reason), which does the one ack.
  assert.match(body, /const finish = \(phase, reason\) => \{[\s\S]*?ackSpeak\(envelope, phase, reason\);/);
  assert.match(body, /addEventListener\('ended', \(\) => finish\('done'\)\)/);
  for (const reason of ['muted', 'no-voice', 'synthesis-ipc-failed', 'synthesis-failed']) {
    assert.match(body, new RegExp(`ackSpeak\\(envelope,\\s*'skipped',\\s*'${reason}'\\)`), `missing skipped ack for ${reason}`);
  }
  for (const reason of ['muted', 'playback-error', 'play-rejected']) {
    assert.match(body, new RegExp(`finish\\('skipped',\\s*'${reason}'\\)`), `missing skipped finish for ${reason}`);
  }
  assert.match(body, /await new Promise/, 'speak() must resolve only once the clip is over, so the local chain serializes');
});

test('widget.js plays speak envelopes through a promise chain — one clip at a time per widget', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'function enqueueSpeak(text, envelope)');
  assert.match(body, /speakChain\s*=\s*speakChain\.then\(\(\)\s*=>\s*speak\(text,\s*envelope\)\)/);
});

test('ackSpeak tolerates envelopes without an id (a pre-handshake publisher still gets played)', () => {
  const src = readSrc('renderer', 'widget.js');
  const body = extractFunctionBody(src, 'function ackSpeak(envelope, phase, reason)');
  assert.match(body, /if \(!envelope \|\| !envelope\.id\) return;/);
  assert.match(body, /window\.las\.ackSpeak\(envelope\.id,\s*phase,\s*reason\)/);
});

test('children rows carry each session\'s title; the menu\'s refresh asks the intelligent sessions for one through the backend', () => {
  const src = readSrc('renderer', 'widget.js');
  assert.match(extractFunctionBody(src, 'function sessionLabel(s)'), /s\.title/);
  assert.match(extractFunctionBody(src, 'function targetRows()'), /sessionLabel\(/, 'every session row is labeled by sessionLabel (runtime · title)');
  const render = extractFunctionBody(src, 'function renderChildrenMenu()');
  assert.match(render, /Refresh descriptions/);
  assert.match(render, /intelligent !== false/, 'no refresh when only a shell is connected: a shell cannot describe itself');
  const ask = extractFunctionBody(src, 'async function requestSessionTitles(btn)');
  assert.match(ask, /window\.las\.requestSessionTitles\(agentName\)/);
  assert.match(ask, /reloadChildrenMenu\(\)/, 'titles arrive asynchronously: re-read the list');
  assert.match(extractFunctionBody(src, 'async function reloadChildrenMenu()'), /refreshSessions\(\)/);
  assert.match(readSrc('preload.js'), /requestSessionTitles: \(name\) => ipcRenderer\.invoke\('agent:request-session-titles', name\)/);
  const ipc = extractFunctionBody(readSrc('main.js'), "ipcMain.handle('agent:request-session-titles', async (_event, name) => {");
  assert.match(ipc, /\/sessions\/titles\/request`/);
  assert.match(ipc, /postBackend\(/);
  assert.match(extractFunctionBody(readSrc('main.js'), 'async function postBackend(urlPath, what, body)'), /method: 'POST'/);
  assert.match(src, /envelope\.kind === 'title-request'/, 'the request itself never shows in the log');
});

// ── mute: cuts the clip in flight, not only the next one ───────────────────

test('muting stops the clip that is playing right now', () => {
  const src = readSrc('renderer', 'widget.js');
  const persistBody = extractFunctionBody(src, 'async function persist(patch) {');
  assert.match(persistBody, /if \(prefs\.mute\) stopCurrentSpeech\(\);/);
  const stopBody = extractFunctionBody(src, 'function stopCurrentSpeech() {');
  assert.match(stopBody, /currentSpeech\.stop\(\)/);
  const speakBody = extractFunctionBody(src, 'async function speak(text, envelope) {');
  assert.match(speakBody, /audioEl\.pause\(\);\s*finish\('skipped', 'muted'\);/);
});

test('muting during synthesis skips playback once the audio is ready', () => {
  const src = readSrc('renderer', 'widget.js');
  const speakBody = extractFunctionBody(src, 'async function speak(text, envelope) {');
  const synth = speakBody.indexOf('synthesizeSpeech(');
  const play = speakBody.indexOf('new Audio(');
  const between = speakBody.slice(synth, play);
  assert.match(between, /if \(prefs\.mute\) \{\s*ackSpeak\(envelope, 'skipped', 'muted'\);\s*return;/);
});

test('a stopped clip acks exactly once (ended after pause must not ack again)', () => {
  const src = readSrc('renderer', 'widget.js');
  const speakBody = extractFunctionBody(src, 'async function speak(text, envelope) {');
  assert.match(speakBody, /if \(settled\) return;\s*settled = true;/);
});

// ── mic gate: nothing speaks while any widget records ────────────────────────
//
// 2026-10-20: LAS voices played over the user's dictation and the agent
// misheard it; a long dictation may be impossible to repeat. While ANY
// window records, every clip pauses or waits — app-wide, and the backend's
// queue is held too. Nothing is dropped.

test('recording a dictation raises the app-wide mic gate, stopping lowers it', () => {
  const src = readSrc('renderer/widget.js');
  const setState = extractFunctionBody(src, 'function setMicState(next)');
  assert.match(setState, /window\.las\.setMicRecording\(agentName, next === 'listening'\)/);
  assert.match(setState, /\(next === 'listening'\) !== \(micState === 'listening'\)/, 'only on a listening transition, not on every state change');
  const main = readSrc('main.js');
  const gate = extractFunctionBody(main, 'function setMicRecording(name, recording)');
  assert.match(gate, /webContents\.send\('mic:held', held\)/, 'every window hears it, not just the recording one');
  assert.match(gate, /postBackend\('\/queue\/hold'/, 'the backend queue is held too');
  assert.match(gate, /setInterval\(/, 'the hold is renewed — the backend lets an unrenewed one lapse');
  const closed = main.slice(main.indexOf("win.on('closed', () => {"));
  assert.match(closed.slice(0, 300), /setMicRecording\(name, false\)/, 'a window closed mid-dictation releases the gate');
});

test('a clip never starts while the mic is held, and the one playing pauses and resumes', () => {
  const src = readSrc('renderer/widget.js');
  const speakBody = extractFunctionBody(src, 'async function speak(text, envelope)');
  assert.ok(speakBody.indexOf('await micReleased()') !== -1 && speakBody.indexOf('await micReleased()') < speakBody.indexOf('mayPlay('),
    'wait for the mic BEFORE asking the queue for the speaker');
  assert.match(speakBody, /if \(!micHeld\) currentSpeech\.resume\(\)/);
  const onHeld = src.slice(src.indexOf('window.las.onMicHeld('));
  assert.match(onHeld.slice(0, 500), /currentSpeech\.audioEl\.pause\(\)/, 'paused, not stopped: it must not be dropped');
  assert.match(onHeld.slice(0, 500), /currentSpeech\.resume\(\)/);
  assert.match(readSrc('preload.js'), /onMicHeld: \(cb\) =>/);
});
