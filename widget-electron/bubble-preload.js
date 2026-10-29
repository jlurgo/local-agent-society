'use strict';
/**
 * contextBridge surface for a speech bubble (renderer/bubble.html). One
 * primitive: tell main what the user did. See bubbles.js for the kinds.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubble', {
  /** @param {'size'|'pin'|'dismiss'|'open'|'voice'|'reply'} kind */
  action: (kind, payload) => ipcRenderer.send('bubble:action', kind, payload || {}),
});
