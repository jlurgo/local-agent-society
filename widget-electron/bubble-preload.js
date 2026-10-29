'use strict';
/**
 * contextBridge surface for a speech bubble (renderer/bubble.html). One
 * primitive: tell main what the user did. See bubbles.js for the kinds.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubble', {
  /** @param {'size'|'pin'|'dismiss'|'open'|'voice'|'mic-stop'|'mic-cancel'|'reply'} kind */
  action: (kind, payload) => ipcRenderer.send('bubble:action', kind, payload || {}),
  /** The agent's dictation phases after a 'voice' action (bubbles.js micStatus).
   * @param {(state: string, detail: object|null) => void} cb */
  onMic: (cb) => ipcRenderer.on('bubble:mic', (_e, state, detail) => cb(state, detail)),
});
