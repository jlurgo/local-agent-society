'use strict';

/**
 * contextBridge surface for the renderer. Renderer runs with
 * contextIsolation + sandbox, no direct Node/Electron access — everything it
 * needs comes through here.
 */

const { contextBridge, ipcRenderer } = require('electron');
const { pickVoice } = require('./lib/voiceHash');
const { KOKORO_VOICES } = require('./lib/kokoroVoices');

contextBridge.exposeInMainWorld('las', {
  /** Deterministic voice selection — see lib/voiceHash.js. */
  pickVoice: (name, locale, voices) => pickVoice(name, locale, voices),

  /** The local Kokoro voice pool (see lib/kokoroVoices.js) — plain data, fed
   * into pickVoice() in place of the old speechSynthesis.getVoices() list. */
  ttsVoices: KOKORO_VOICES,

  /** Synthesize `text` with a Kokoro voice id + kokoro-onnx lang code (both
   * from ttsVoices) via the backend's /tts/synthesize; returns
   * {ok:true, wav: ArrayBuffer} or {ok:false, error}. */
  synthesizeSpeech: (text, voiceId, lang) => ipcRenderer.invoke('tts:synthesize', text, voiceId, lang),

  /** Speak-queue handshake: report one speak envelope's progress back to the
   * backend drainer (POST /queue/ack) so the NEXT agent's clip is held until
   * this one is over. phase: 'started' | 'done' | 'skipped' (+ reason). */
  ackSpeak: (id, phase, reason, durationMs) => ipcRenderer.invoke('queue:ack', id, phase, reason, durationMs),

  /** Progress pushes during synthesizeSpeech (model download/load vs.
   * inference), same shape as onAudioStatus below.
   * @param {(status: {state:string, progress?:number, file?:string}) => void} cb */
  onTtsStatus: (cb) => {
    ipcRenderer.on('tts:status', (_event, status) => cb(status));
  },

  /** Agent name this window was opened for, read from ?agent= query string. */
  getAgentName: () => new URLSearchParams(window.location.search).get('agent') || '',

  /** Write a line to session/widget.log (see main.js's persistent logging
   * section) — the renderer has no fs access, so this is the only way it
   * can leave a durable trace. level: 'debug'|'info'|'warn'|'error'. */
  log: (level, component, message) => ipcRenderer.send('log:write', level, component, message),

  getPrefs: (name) => ipcRenderer.invoke('prefs:get', name),
  setPrefs: (name, patch) => ipcRenderer.invoke('prefs:set', name, patch),

  /** Tile reconciler settings shared by every widget of this app instance
   * (main.js "tile reconciler"): heartbeat and shrink delay, in ms. get()
   * also returns `limits` and `defaults`; set() returns the clamped result. */
  getTileSettings: () => ipcRenderer.invoke('tiles:get'),
  setTileSettings: (patch) => ipcRenderer.invoke('tiles:set', patch),
  /** Another widget changed the tile settings. @param {(settings: object) => void} cb */
  onTileSettings: (cb) => ipcRenderer.on('tiles:changed', (_e, settings) => cb(settings)),

  /** Update notice: { available, behind, commits: [{sha, subject}], checked_at, error } or null (backend/updates.py). */
  getUpdateStatus: () => ipcRenderer.invoke('update:get'),
  /** Fetch the upstream now; resolves to the fresh status. */
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  /** Put the update command on the clipboard; resolves to it. */
  copyUpdateCommand: () => ipcRenderer.invoke('update:copy-command'),
  /** The status changed (a new version appeared, or was installed). @param {(status: object) => void} cb */
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, status) => cb(status)),

  /** Grow/shrink this window by (dw, dh) pixels — see .resize-handle in widget.css. */
  resizeBy: (dw, dh) => ipcRenderer.send('window:resize-by', dw, dh),

  /** Grow the window to fit an overlay panel (settings),
   * or shrink it back to its remembered compact size. Idempotent.
   * `height` optionally overrides the default expanded height — the settings
   * panel is short and fixed (no scrolling list), so it asks for a smaller
   * height than the TTY-picker panel's default. */
  setExpanded: (expanded, height) => ipcRenderer.send('window:set-expanded', expanded, height),

  /** "Expand when hidden" (retired Swift "Expand on space change"): balloon
   * to fill the screen, click-through, when occluded/off-Space; shrink back
   * when visible again. See main.js's window:set-occlusion-expanded comment. */
  reportVisibility: (hidden, allowed) => ipcRenderer.send('window:report-visibility', hidden, allowed),
  /** Main decides whether this widget is grown to its mosaic tile (main.js tile reconciler) and tells the face here. */
  onOcclusionState: (cb) => ipcRenderer.on('window:occlusion-state', (_e, expanded) => cb(expanded)),

  /** @param {(envelope: object, topic: string) => void} cb */
  onVortexiaMessage: (cb) => {
    ipcRenderer.on('vortexia:message', (_event, envelope, topic) => cb(envelope, topic));
  },

  /** @param {(status: {connected: boolean, error?: string}) => void} cb */
  onVortexiaStatus: (cb) => {
    ipcRenderer.on('vortexia:status', (_event, status) => cb(status));
  },

  /** Fired after the system wakes from sleep (main.js's powerMonitor
   * 'resume' handler) — tells the renderer to re-check document.
   * visibilityState immediately instead of waiting on a fresh occlusion
   * event that may never re-fire. @param {() => void} cb */
  onSystemResume: (cb) => {
    ipcRenderer.on('system:resume', () => cb());
  },

  // ── face buttons ───────────────────────────────────────────────────────

  /** This agent's registered voice + its locale (e.g. "es-MX"), from the backend. */
  getAgentInfo: (name) => ipcRenderer.invoke('agent:info', name),

  /** Generalized "publish `text` to `toName`'s vortexia inbox" primitive. */
  vortexiaSend: (toName, text) => ipcRenderer.invoke('vortexia:send', toName, text),

  /** Mic dictation -> this agent (the faithful equivalent of the retired
   * live-TTY injectToSession). No target here: WHICH of the agent's
   * sessions hears it is the agent's own `sessions.target`
   * (.las-agent.json, the children button), applied by the backend. */
  sendToSelf: (name, text) => ipcRenderer.invoke('vortexia:send', name, text),

  /** Connected runtime sessions of this agent — its children — with the
   * agent's `target`/`cc_default` choice (children button, settings). */
  getAgentSessions: (name) => ipcRenderer.invoke('agent:sessions', name),

  /** This agent's .las-agent.json as the backend reads it. */
  getAgentConfig: (name) => ipcRenderer.invoke('agent:config', name),

  /** Patch the `sessions` section of this agent's .las-agent.json
   * ({target?, cc_default?}) through the backend — the same file
   * `las agent target` writes. Resolves to the backend's config view. */
  setSessionsConfig: (name, patch) => ipcRenderer.invoke('agent:config-sessions', name, patch),

  /** Ask every intelligent session of this agent to title itself (children
   * menu refresh). Resolves to {asked, skipped} or null; the titles arrive
   * later — re-read getAgentSessions. */
  requestSessionTitles: (name) => ipcRenderer.invoke('agent:request-session-titles', name),

  /** Make one session's terminal findable (unique title + bell) and focus it
   * where the terminal app allows (Ghostty). Resolves to {ok, focused}. */
  findSession: (name, sid) => ipcRenderer.invoke('agent:session-find', name, sid),

  /** Close one session's terminal (its tty is hung up). Resolves to the
   * backend's sessions view, or null. */
  closeSession: (name, sid) => ipcRenderer.invoke('agent:session-close', name, sid),

  /** Local Whisper transcription (main.js's "audio transcription" section) —
   * replaces the broken Electron SpeechRecognition/webkitSpeechRecognition.
   * `pcmBuffer` must be an ArrayBuffer of mono Float32 PCM samples at 16kHz
   * (see renderer/widget.js's blobToMono16kPCM). Returns
   * {ok:true, text} or {ok:false, error}. */
  transcribeAudio: (pcmBuffer, languageHint, opts) => ipcRenderer.invoke('audio:transcribe', pcmBuffer, languageHint, opts || null),

  /** Progress/state pushes during transcribeAudio (model download/load vs.
   * actual inference), so the mic button isn't silent during first-run
   * latency. @param {(status: {state:string, progress?:number, file?:string}) => void} cb */
  onAudioStatus: (cb) => {
    ipcRenderer.on('audio:status', (_event, status) => cb(status));
  },

  /** This window started/stopped recording a dictation. Resolves to whether
   * any window is recording now (the app-wide mic gate, main.js). */
  setMicRecording: (name, recording) => ipcRenderer.invoke('mic:recording', name, recording),

  /** A speech bubble drives this widget's dictation (main.js onBubbleAction):
   * command 'start' (same as a click on the mic button), 'stop' (stop and
   * send) or 'cancel' (stop, send nothing). */
  onMicRequest: (cb) => ipcRenderer.on('mic:request', (_event, command) => cb(command || 'start')),
  /** The phases of this widget's dictation, for the bubble that asked for
   * it: listening / transcribing / sent {text} / failed {error} / cancelled / idle. */
  micStatus: (name, state, detail) => ipcRenderer.send('mic:status', name, state, detail),

  /** The app-wide mic gate changed: `held` = some window is recording, so
   * nothing may speak. @param {(held: boolean) => void} cb */
  onMicHeld: (cb) => {
    ipcRenderer.on('mic:held', (_event, held) => cb(held));
  },

  /** "Open" button: a NEW window of the default terminal ('terminal'), or
   * the file manager ('folder'), at this agent's registered directory —
   * main.js resolves the path from the backend registry. Resolves to
   * {ok, action, path, app?} or {ok:false, error}. */
  openAgent: (name, action) => ipcRenderer.invoke('agent:open', name, action),
  /** Name of the terminal app the 'terminal' open action launches (menu label). */
  getDefaultTerminalApp: () => ipcRenderer.invoke('terminal:default-app'),

  /** Clear button: types `text` (literally "/clear") into the agent's live
   * linked terminal(s) — the backend's AppleScript-via-iTerm write, not
   * vortexia messaging. */
  writeToTty: (name, text) => ipcRenderer.invoke('agent:tty-write', name, text),

  /** Door button: mark this agent inactive on the backend and close this
   * widget window. See main.js's agent:deactivate comment. */
  deactivateAgent: (name) => ipcRenderer.invoke('agent:deactivate', name),

  /** "Wake up via vortexia" settings checkbox — backend-synced (not
   * electron-store), same flag `las agent focus`'s wake fallback reads. */
  setWakeEnabled: (name, enabled) => ipcRenderer.invoke('agent:set-wake-enabled', name, enabled),
  getWakeEnabled: (name) => ipcRenderer.invoke('agent:get-wake-enabled', name),
});
