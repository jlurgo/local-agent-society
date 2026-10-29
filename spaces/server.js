#!/usr/bin/env node
'use strict';
/**
 * las-spaces — the world model of this Mac's Spaces, windows and LAS agents,
 * its windows' pixels, and the commands to go places; served to a flat page
 * (spaces/xr/world.html, any browser on the Mac) and to the headset app
 * (spaces/xr/, reached as http://localhost:PORT over `adb reverse`).
 * Port from the LAS registry (`las ports claim las-spaces`). No deps beyond
 * koffi + sharp (lib/deps.js). See docs/plans/2026-10-29-quest-spaces.md.
 *
 *   GET  /world                      the world (JSON); also pushed over /ws as {type:'world'} when it changes
 *   GET  /thumb/:wid?w=480           the window's pixels (JPEG), ~1.5 s cache
 *   POST /space/:id/activate         switch the Mac to that Space
 *   POST /window/:wid/focus          bring that window to the front (switches Space too)
 *   POST /hello                      a report from the headset page (logged)
 *   WS   /ws                         world pushes; text frames in are logged
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const mac = require('./lib/mac');
const { buildWorld } = require('./lib/world');

const PORT = Number(process.env.LAS_SPACES_PORT || process.argv[2] || 9002);
const XR_DIR = path.join(__dirname, 'xr');
const LOG_PATH = path.join(__dirname, '..', 'session', 'spaces.log');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const WORLD_TICK_MS = 1000;
const THUMB_TTL_MS = 1500;
const LIVE_TTL_MS = 250;      // the panel being looked at: refreshed as fast as it is asked for
const VENDOR_DIR = path.join(__dirname, 'node_modules');

function log(level, component, message) {
  const line = `[${new Date().toISOString()}] ${level.padEnd(5)} [${component}] ${message}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_PATH, line); } catch { /* best effort */ }
}
const info = (c, m) => log('INFO', c, m);
const warn = (c, m) => log('WARN', c, m);

// ── world: rebuilt every tick, pushed when it changed ──────────────────────
let world = { at: 0, displays: [], agents: [] };
let worldKey = '';
let building = false;
async function tickWorld() {
  if (building) return;
  building = true;
  try {
    const next = await buildWorld();
    const key = JSON.stringify({ d: next.displays, a: next.agents });
    world = next;
    if (key !== worldKey) {
      worldKey = key;
      broadcast({ type: 'world', world });
    }
  } catch (err) {
    warn('world', `build failed: ${err && err.message ? err.message : err}`);
  } finally {
    building = false;
  }
}

// ── thumbnails: one capture per window per TTL, never two of the same at once,
// and never more than CAPTURE_CONCURRENCY captures in flight at all: a page
// asking for every panel at once must not take the Mac's cores (seen: 2
// cores, load 60). Beyond CAPTURE_QUEUE_MAX waiting, new asks are refused
// (the page simply shows the last frame a little longer).
const CAPTURE_CONCURRENCY = 2;
const CAPTURE_QUEUE_MAX = 24;
let inFlight = 0;
const waiting = [];
function pump() {
  while (inFlight < CAPTURE_CONCURRENCY && waiting.length) {
    const job = waiting.shift();
    inFlight++;
    mac.captureWindow(job.wid, { maxWidth: job.w })
      .then(job.resolve, (err) => { warn('thumb', `${job.wid}: ${err && err.message ? err.message : err}`); job.resolve(null); })
      .finally(() => { inFlight--; pump(); });
  }
}
function capture(wid, w) {
  if (waiting.length >= CAPTURE_QUEUE_MAX) return Promise.resolve(null);
  return new Promise((resolve) => { waiting.push({ wid, w, resolve }); pump(); });
}
const thumbs = new Map();   // key → { at, promise }
function thumb(wid, w, live = false) {
  const key = `${wid}:${w}`;
  const c = thumbs.get(key);
  const now = Date.now();
  if (c && now - c.at < (live ? LIVE_TTL_MS : THUMB_TTL_MS)) return c.promise;
  const promise = capture(wid, w);
  thumbs.set(key, { at: now, promise });
  if (thumbs.size > 400) thumbs.delete(thumbs.keys().next().value);
  return promise;
}

// ── commands ───────────────────────────────────────────────────────────────
function osascript(lines) {
  return new Promise((resolve) => {
    execFile('osascript', lines.flatMap((l) => ['-e', l]), { timeout: 8000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout).trim(), stderr: String(stderr || (err && err.message) || '').trim() }));
  });
}

/** Switch to a Space. Direct: raise the frontmost window on it — macOS jumps
 * there in one move. Fallback (a Space with no window): ctrl+←/→ as many
 * times as the Mission Control distance, which walks through every desktop
 * in between. */
async function activateSpace(id) {
  const d = world.displays.find((x) => x.spaces.some((s) => s.id === id));
  if (!d) return { ok: false, error: 'unknown space' };
  const from = d.spaces.findIndex((s) => s.id === d.current);
  const to = d.spaces.findIndex((s) => s.id === id);
  if (from === -1 || to === -1) return { ok: false, error: 'no current space' };
  if (from === to) return { ok: true, steps: 0 };
  // A vehicle window on the target Space, most reliable first: a terminal
  // (its app scripting raises it for real), then anything that is not a
  // browser (Chrome's scripting does not switch Spaces — see focusWindow).
  const wins = d.spaces[to].windows;   // front to back
  const vehicle = wins.find((w) => w.kind === 'terminal') || wins.find((w) => w.kind !== 'browser');
  if (vehicle) {
    const r = await raiseWindow(vehicle, d.spaces[to].id);
    if (r.ok) { info('space', `activate ${id}: jumped via "${vehicle.title.slice(0, 40)}" (${vehicle.app})`); return { ok: true, via: 'window', wid: vehicle.wid }; }
    warn('space', `activate ${id}: direct jump failed (${r.error}); stepping`);
  }
  const keyCode = to > from ? 124 : 123;   // → / ←
  const steps = Math.abs(to - from);
  const script = [`tell application "System Events"`, ...Array.from({ length: steps }, () => `key code ${keyCode} using control down\ndelay 0.25`), 'end tell'];
  const r = await osascript([script.join('\n')]);
  info('space', `activate ${id}: ${from} → ${to} (${steps} step${steps === 1 ? '' : 's'}) ${r.ok ? 'ok' : 'FAILED ' + r.stderr}`);
  return r.ok ? { ok: true, steps } : { ok: false, error: r.stderr };
}

/** The Space the display is showing right now (fresh read, not the cached world). */
function currentSpaceNow() {
  try { return mac.displaySpaces()[0].current; } catch { return null; }
}

/**
 * Bring a window to the front — and, when it lives on another Space, make
 * macOS switch there. Raising through System Events is not enough for an
 * app that also has windows on the current Space (Chrome, Terminal): the app
 * activates where you are. So scriptable apps are told to make THAT window
 * their front window first (`set index … to 1`), then activated; the Space
 * switch is verified by reading the current Space again, and a miss falls
 * back to the generic raise.
 */
async function focusWindow(wid) {
  let win = null, space = null;
  for (const d of world.displays) for (const s of d.spaces) for (const w of s.windows) if (w.wid === wid) { win = w; space = s.id; }
  if (!win) return { ok: false, error: 'unknown window' };
  if (win.kind === 'browser' && space !== currentSpaceNow()) {
    // Chrome never switches Space by itself: go there first with a reliable window, then raise the browser window there.
    const r = await activateSpace(space);
    if (!r.ok) return r;
    await new Promise((res) => setTimeout(res, 400));   // let the Space animation land
  }
  return raiseWindow(win, space);
}

async function raiseWindow(win, space) {
  const wid = win.wid;
  const esc = (t) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const before = currentSpaceNow();
  const scripts = [];
  if (win.app === 'Google Chrome' || win.app === 'Brave Browser' || win.app === 'Chromium') {
    scripts.push(`tell application "${win.app}"\n  set index of (first window whose title is "${esc(win.title)}") to 1\n  activate\nend tell`);
  } else if (win.app === 'Terminal' || win.app === 'iTerm2') {
    scripts.push(`tell application "${win.app}"\n  set index of (first window whose name is "${esc(win.title)}") to 1\n  activate\nend tell`);
  }
  scripts.push(`tell application "System Events"\n  tell (first process whose unix id is ${win.pid || 0})\n    set frontmost to true\n    try\n      perform action "AXRaise" of (first window whose name is "${esc(win.title)}")\n    end try\n  end tell\nend tell`);
  let last = null;
  for (const script of scripts) {
    last = await osascript([script]);
    if (!last.ok) { warn('window', `focus ${wid}: ${last.stderr.slice(0, 120)}`); continue; }
    if (space !== before) await new Promise((res) => setTimeout(res, 350));   // the Space animation must land before the read
    const after = currentSpaceNow();
    const switched = space === before || after === space;
    info('window', `focus ${wid} "${win.title.slice(0, 40)}" (${win.app}) ok${space !== before ? (switched ? ', switched Space' : ', Space did NOT switch') : ''}`);
    if (switched) return { ok: true, switched: space !== before };
  }
  return { ok: false, error: last && last.stderr ? last.stderr : 'the Space did not switch' };
}

// ── http ───────────────────────────────────────────────────────────────────
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m;
  if (req.method === 'GET' && p === '/world') return json(res, 200, world);
  if (req.method === 'GET' && (m = /^\/thumb\/(\d+)$/.exec(p))) {
    const w = Math.max(64, Math.min(1600, Number(url.searchParams.get('w')) || 480));
    const r = await thumb(Number(m[1]), w, url.searchParams.has('live'));
    if (!r) return json(res, 404, { error: 'no image' });
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-size': `${r.width}x${r.height}`, 'x-source': `${r.srcWidth}x${r.srcHeight}` });
    return res.end(r.jpeg);
  }
  if (req.method === 'POST' && (m = /^\/space\/(\d+)\/activate$/.exec(p))) return json(res, 200, await activateSpace(m[1]));
  if (req.method === 'POST' && (m = /^\/window\/(\d+)\/focus$/.exec(p))) return json(res, 200, await focusWindow(Number(m[1])));
  if (req.method === 'POST' && p === '/hello') {
    info('hello', (await readBody(req)).replace(/\s+/g, ' ').slice(0, 1000));
    return res.writeHead(204).end();
  }
  // /vendor/<package>/... → spaces/node_modules (three.js for the headset app; served, never bundled)
  const rel = p === '/' ? '/index.html' : decodeURIComponent(p);
  const root = rel.startsWith('/vendor/') ? VENDOR_DIR : XR_DIR;
  const file = path.normalize(path.join(root, rel.startsWith('/vendor/') ? rel.slice('/vendor/'.length) : rel));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

// ── minimal WebSocket (RFC 6455, text frames, no deps) ─────────────────────
const sockets = new Set();
function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([head, payload]);
}
function broadcast(obj) {
  if (!sockets.size) return;
  const f = frame(JSON.stringify(obj));
  for (const s of sockets) s.write(f);
}
server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  info('ws', `open from ${socket.remoteAddress} (${sockets.size} client${sockets.size === 1 ? '' : 's'})`);
  socket.write(frame(JSON.stringify({ type: 'world', world })));
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mask = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      if (op === 8) { socket.end(); return; }
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 1 && fin) info('ws', payload.toString('utf8').replace(/\s+/g, ' ').slice(0, 1000));
    }
  });
  const drop = () => { sockets.delete(socket); };
  socket.on('error', drop);
  socket.on('close', drop);
});

server.listen(PORT, '127.0.0.1', () => {
  info('server', `las-spaces listening on http://127.0.0.1:${PORT} (xr dir ${XR_DIR})`);
  tickWorld();
  setInterval(tickWorld, WORLD_TICK_MS);
});
