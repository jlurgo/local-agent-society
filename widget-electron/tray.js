'use strict';

/**
 * System tray icon + menu for the Electron widget.
 *
 * One tray icon for the whole app (mirrors widget/tray.swift's single
 * NSStatusItem), listing every agent known to the backend registry
 * (`GET /agents` on :8700) with a click handler that opens/focuses that
 * agent's widget window.
 */

const path = require('node:path');
const { Tray, Menu, nativeImage, app } = require('electron');

// App branding icon (see build/icon.png), downscaled to a menu-bar-sized
// template image. Falls back to a plain circle if the asset is somehow
// missing (e.g. a stripped dev checkout) so the tray never fails to start.
function trayIcon() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  const full = nativeImage.createFromPath(iconPath);
  if (!full.isEmpty()) {
    return full.resize({ width: 18, height: 18 });
  }
  const FALLBACK_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAiElEQVR4Ae3XwQmAMAxA0Y7iCu7iJq7hLm7iZQVBUeqrLXjxwyOYnFICH3IqhFxK1QVpF7Q4L6EmDXqnUqQd8ir1B60pC9UDaBAvhZAtCDoiWZAtCDoiWZAtCDoiWZAtCDoiWZAtCDoiWZAtCDoiWZAtCDoiWZAtCDoiWZAtCDoiWZAtCDoiWZAtCDoi+cQNBGgQm0FMYVUAAAAASUVORK5CYII=';
  return nativeImage.createFromBuffer(Buffer.from(FALLBACK_PNG_BASE64, 'base64'));
}

async function fetchAgentNames(registryUrl) {
  try {
    const res = await fetch(`${registryUrl}/agents`);
    if (!res.ok) return [];
    const agents = await res.json();
    return Object.keys(agents).sort();
  } catch {
    return [];
  }
}

async function buildMenu({ registryUrl, onSelectAgent, onReload, onQuit }) {
  const names = await fetchAgentNames(registryUrl);
  const agentItems = names.length
    ? names.map((n) => ({ label: n, click: () => onSelectAgent(n) }))
    : [{ label: '(no agents registered)', enabled: false }];

  return Menu.buildFromTemplate([
    { label: 'Local Agent Society — Electron widget (dev)', enabled: false },
    { type: 'separator' },
    ...agentItems,
    { type: 'separator' },
    // Re-runs every widget's face from the checkout (main.js reloadWidgets):
    // a renderer/CSS/preload edit shows up without rebuilding or restarting.
    ...(onReload ? [{ label: 'Reload widgets', click: () => onReload() }] : []),
    { label: 'Quit', click: () => (onQuit ? onQuit() : app.quit()) },
  ]);
}

/**
 * @param {{registryUrl: string, onSelectAgent: (name: string) => void, onReload?: () => void, onQuit?: () => void}} opts
 * @returns {Tray}
 */
function createTray(opts) {
  const tray = new Tray(trayIcon());
  tray.setToolTip('Local Agent Society (Electron)');

  const refresh = async () => tray.setContextMenu(await buildMenu(opts));
  refresh();

  tray.on('click', async () => {
    await refresh();
    tray.popUpContextMenu();
  });

  return tray;
}

module.exports = { createTray, buildMenu, fetchAgentNames };
