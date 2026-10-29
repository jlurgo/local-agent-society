'use strict';
/**
 * The world model: displays → Spaces (Mission Control order, current) →
 * windows, plus the LAS agents (which Space each lives on, its color, its
 * sessions and which terminal windows those are). One snapshot per call;
 * the server rebuilds it every second and pushes it when it changed.
 * See docs/plans/2026-10-29-quest-spaces.md ("The workspace view").
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const mac = require('./mac');

const REGISTRY_URL = process.env.LAS_REGISTRY_URL || 'http://localhost:8700';
const TILES_PATH = path.join(__dirname, '..', '..', 'session', 'widget-tiles.json');
const PREFS_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'widget-electron', 'widget-electron-prefs.json');
const TERMINAL_APPS = new Set(['Terminal', 'iTerm2', 'Ghostty', 'Alacritty', 'kitty', 'WezTerm', 'Warp']);
const BROWSER_APPS = new Set(['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Brave Browser', 'Arc']);

const spaceCache = new Map();  // wid → { space, at }
function spaceOf(wid, now) {
  const c = spaceCache.get(wid);
  if (c && now - c.at < 5000) return c.space;
  const space = mac.spaceOfWindow(wid);
  spaceCache.set(wid, { space, at: now });
  return space;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

async function fetchJson(url, ms = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

let agentsCache = { at: 0, agents: [] };
/** Agents + sessions from the LAS backend, refreshed every 5 s; colors from the widget's prefs; Space from the tiles file. */
async function loadAgents(now) {
  if (now - agentsCache.at < 5000) return agentsCache.agents;
  const registry = await fetchJson(`${REGISTRY_URL}/agents`);
  if (!registry) { agentsCache.at = now - 3000; return agentsCache.agents; }   // backend slow or down: keep the last good list, retry soon
  const prefs = readJson(PREFS_PATH, {}).agents || {};
  const tiles = readJson(TILES_PATH, { widgets: [] }).widgets || [];
  const agents = [];
  for (const [name, info] of Object.entries(registry)) {
    const sessions = (await fetchJson(`${REGISTRY_URL}/agents/${encodeURIComponent(name)}/sessions`)) || { sessions: [] };
    const tile = tiles.find((t) => t.name === name);
    agents.push({
      name,
      path: info.path || null,
      inactive: Boolean(info.inactive),
      color: (prefs[name] && prefs[name].color) || null,
      space: tile ? tile.space : null,
      sessions: (sessions.sessions || []).map((s) => ({ sid: s.sid, runtime: s.runtime, title: s.title || null, cwd: s.cwd || null, pid: s.pid || null, default: Boolean(s.default) })),
    });
  }
  agentsCache = { at: now, agents };
  return agents;
}

/** Which agent session a terminal window shows, by the title the LAS runtimes set: "<cwd> — <Agent> · <runtime> — <session title>". */
function sessionForWindow(win, agents) {
  for (const a of agents) {
    for (const s of a.sessions) {
      const marker = `${a.name} · ${s.runtime}`;
      if (win.title.includes(marker) || (s.title && win.title.includes(s.title)) || (s.cwd && win.title.startsWith(`${path.basename(s.cwd)} — `) && win.title.includes(a.name))) {
        return { agent: a.name, sid: s.sid, runtime: s.runtime };
      }
    }
  }
  return null;
}

async function buildWorld() {
  const now = Date.now();
  const displays = mac.displaySpaces();
  // Untitled windows are helpers (Chrome's hidden ones capture black): only titled windows, plus any terminal.
  const windows = mac.listWindows().filter((w) => w.title || TERMINAL_APPS.has(w.app));
  const agents = await loadAgents(now);
  const bySpace = new Map();
  for (const w of windows) {
    const space = spaceOf(w.wid, now);
    if (!space) continue;
    const kind = TERMINAL_APPS.has(w.app) ? 'terminal' : BROWSER_APPS.has(w.app) ? 'browser' : 'other';
    const entry = { wid: w.wid, pid: w.pid, app: w.app, title: w.title, kind, bounds: w.bounds, z: w.z, session: kind === 'terminal' ? sessionForWindow(w, agents) : null };
    if (!bySpace.has(space)) bySpace.set(space, []);
    bySpace.get(space).push(entry);
  }
  const out = { at: now, displays: [], agents };
  for (const d of displays) {
    const spaces = d.spaces.map((sp, index) => ({
      id: sp.id,
      index,
      type: sp.type,
      current: sp.id === d.current,
      agents: agents.filter((a) => a.space === sp.id).map((a) => a.name),
      windows: (bySpace.get(sp.id) || []).sort((a, b) => a.z - b.z),
    }));
    out.displays.push({ id: d.display, current: d.current, spaces });
  }
  return out;
}

module.exports = { buildWorld };
