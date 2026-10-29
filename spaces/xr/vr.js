// LAS Spaces — the immersive view (WebXR + three.js). See
// docs/plans/2026-10-29-quest-spaces.md.
//
// A view of the LAS AGENTS over your room (passthrough). Each agent is a
// BUBBLE — a flat circle in its widget color with its name — and the
// bubbles float in front of you in a SUNFLOWER (Vogel's spiral), drifting
// with your gaze like a swarm. Trigger on one selects it: it takes the
// center and its windows — the terminals of its sessions first, then the
// other terminals and the browser windows on its Space — form a MOSAIC
// ring (terminals live text, browsers live pixels). Trigger on a panel
// opens a SCREEN: big, movable (grip) and resizable (grip a corner, or
// both grips); several can be open; the bubbles move aside of open
// screens. On a screen the trigger clicks, the thumbstick scrolls and a
// keyboard types — the Mac is focused on that window at the first
// interaction, never before. Trigger on nothing collapses everything back
// to the bubbles. A talking agent comes closer, inflates and pulses with
// its words in a speech bubble while its voice plays.
// Outside VR the same scene renders flat with a mouse, for checks from the Mac.
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';

const hud = document.getElementById('hud');
const report = (data) => fetch('/hello', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: Date.now(), vr: true, ...data }) }).catch(() => {});
window.addEventListener('error', (e) => report({ error: String(e.message), at: `${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => report({ error: 'unhandled: ' + String(e.reason && e.reason.message || e.reason) }));
const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));

// ── layout (meters / radians) — everything on spheres around your head ─────
const EYE_Y = 1.25;
const CLOUD = { r: 1.9, step: 0.2, follow: 0.06, bubbleR: 0.21, margin: 0.05, attract: 14, damp: 5.5, repel: 9, gap: 1.06 };   // sunflower of bubbles: follows the gaze, flows around what is in the middle
const MOSAIC = { r: 1.85, az: 0.36, el: 0.27, aside: 0.62 };
const PANEL_W = 0.5, PANEL_H = PANEL_W * 9 / 16, LABEL_H = 0.045;
const THUMB_W = 400, LIVE_W = 1100, SCREEN_W = 1500, SCREEN_W_HI = 2400, SCREEN_WIDTH_M = 1.7, SCREEN_DIST = 1.4, MAX_SCREENS = 3;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

// ── renderer / scene ───────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = null;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 60);
camera.position.set(0, EYE_Y, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 1.1));
const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.MeshBasicMaterial({ color: 0x14141a }));
floor.rotation.x = -Math.PI / 2; floor.visible = false; scene.add(floor);
const grid = new THREE.GridHelper(12, 24, 0x262630, 0x1c1c24); grid.position.y = 0.001; grid.visible = false; scene.add(grid);
window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });
let passthrough = false;
(async () => {
  const ar = navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  passthrough = Boolean(ar);
  document.body.appendChild(passthrough ? ARButton.createButton(renderer, { optionalFeatures: ['local-floor', 'hand-tracking'] }) : VRButton.createButton(renderer));
  report({ passthrough });
  if (!passthrough) { scene.background = new THREE.Color(0x0f0f14); floor.visible = grid.visible = true; }
})();

// ROOT holds the display; a grip on nothing moves it, two grips scale it.
// Placement is relative to the HEAD (an AR session may not grant a floor).
const root = new THREE.Group();
scene.add(root);
let headY = null, rebase = false, rebaseFrames = 0;
let saved = null;
try { saved = JSON.parse(localStorage.getItem('las-spaces-root') || 'null'); } catch { saved = null; }
if (saved && saved.s) root.scale.setScalar(saved.s);
if (saved && saved.dx !== undefined) root.position.set(saved.dx, 0, saved.dz);
const saveRoot = () => { try { localStorage.setItem('las-spaces-root', JSON.stringify({ dx: root.position.x, dy: headY == null ? 0 : root.position.y - (headY - EYE_Y), dz: root.position.z, s: root.scale.x })); } catch { /* ignore */ } };
function rebaseToHead() {
  const cam = renderer.xr.getCamera();
  if (!cam || !Number.isFinite(cam.position.y) || cam.position.y === 0) return false;
  headY = cam.position.y;
  root.position.y = (headY - EYE_Y) + ((saved && saved.dy) || 0);
  report({ rebase: true, headY: Number(headY.toFixed(2)) });
  return true;
}
const viewer = new THREE.Vector3(), viewerWorld = new THREE.Vector3();   // the eyes, in root space / world
let headYaw = 0, headPitch = 0, gazeAz = 0, gazeEl = 0;   // where you look (in root space), and the smoothed direction the bubbles follow
const dirFrom = (az, el) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
const onSphere = (az, el, r) => viewer.clone().addScaledVector(dirFrom(az, el), r / root.scale.x);
function place(obj, az, el, r) { obj.position.copy(onSphere(az, el, r)); obj.lookAt(viewerWorld); }

// ── text as textures ───────────────────────────────────────────────────────
function textTexture(text, { width = 512, height = 64, bg = 'rgba(0,0,0,0)', fg = '#eee', font = '28px -apple-system, system-ui, sans-serif', align = 'left', pad = 14 } = {}) {
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, width, height);
  g.fillStyle = fg; g.font = font; g.textBaseline = 'middle'; g.textAlign = align;
  let t = String(text);
  while (g.measureText(t).width > width - 2 * pad && t.length > 3) t = t.slice(0, -2) + '…';
  g.fillText(t, align === 'center' ? width / 2 : pad, height / 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter;
  return tex;
}
function bubbleTexture(text, color) {
  const W = 768, pad = 28, font = 30, lineH = 38, maxLines = 7;
  const c = document.createElement('canvas'); const g = c.getContext('2d');
  g.font = `${font}px -apple-system, system-ui, sans-serif`;
  const words = String(text).split(/\s+/), lines = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (g.measureText(t).width > W - 2 * pad && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/.{3}$/, '…'); }
  const H = pad * 2 + lines.length * lineH + 30;
  c.width = W; c.height = H;
  g.fillStyle = color; roundRect(g, 0, 0, W, H - 30, 26); g.fill();
  g.beginPath(); g.moveTo(W / 2 - 22, H - 32); g.lineTo(W / 2, H); g.lineTo(W / 2 + 22, H - 32); g.closePath(); g.fill();
  g.fillStyle = ink(color); g.font = `${font}px -apple-system, system-ui, sans-serif`; g.textBaseline = 'top';
  lines.forEach((l, i) => g.fillText(l, pad, pad + i * lineH));
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter;
  return { tex, aspect: W / H };
}
/** A bubble face: a filled circle in the agent's color with its name inside, big and high-contrast, sized to fit. */
function bubbleFaceTexture(name, color) {
  const S = 512, c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.fillStyle = color; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 6, 0, Math.PI * 2); g.fill();
  g.strokeStyle = ink(color) === '#f4f4f4' ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)'; g.lineWidth = 8; g.stroke();
  g.fillStyle = ink(color); g.textAlign = 'center'; g.textBaseline = 'middle';
  // Fit the name on one line inside the circle; a long name gets two lines at a camelCase/space break.
  let size = 120, lines = [String(name)];
  const fits = (ls, sz) => { g.font = `bold ${sz}px -apple-system, system-ui, sans-serif`; return ls.every((l) => g.measureText(l).width <= S * 0.74); };
  while (!fits(lines, size) && size > 64) size -= 6;
  if (!fits(lines, size)) {
    const m = /^(.{3,})?([A-Z][a-z]+|[\s_-].+)$/.exec(name); const i = name.search(/(?<=[a-z])[A-Z]|[\s_-]/);
    if (i > 2) { lines = [name.slice(0, i), name.slice(i).replace(/^[\s_-]/, '')]; size = 110; while (!fits(lines, size) && size > 48) size -= 6; }
    else { while (!fits(lines, size) && size > 36) size -= 6; }
  }
  g.font = `bold ${size}px -apple-system, system-ui, sans-serif`;
  const lh = size * 1.05, y0 = S / 2 - (lines.length - 1) * lh / 2;
  lines.forEach((l, i) => g.fillText(l, S / 2, y0 + i * lh));
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.anisotropy = 4;
  return tex;
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
const ink = (hex) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || ''); if (!m) return '#141414'; const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45 ? '#f4f4f4' : '#141414'; };
function disposeObject(o) { o.traverse((c) => { if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); } if (c.geometry) c.geometry.dispose(); }); }
function unhover(o) { const i = hoverables.indexOf(o); if (i !== -1) hoverables.splice(i, 1); }

// ── terminal text → texture ────────────────────────────────────────────────
const termTex = new Map();
function drawTerminal(wid, { rows, cols, text }) {
  rows = Math.max(1, rows || 24); cols = Math.max(1, cols || 80);
  const charW = Math.min(9, Math.floor(2048 / cols)), fontPx = Math.round(charW / 0.6), lineH = Math.round(fontPx * 1.22);
  const W = cols * charW, H = rows * lineH;
  let t = termTex.get(wid);
  if (!t || t.canvas.width !== W || t.canvas.height !== H) {
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (t) t.tex.dispose();
    t = { tex, canvas, aspect: W / H }; termTex.set(wid, t);
    for (const p of panels) if (p.wid === wid) applyTexture(p.mesh, tex, t.aspect);
    for (const sc of screens) if (sc.wid === wid) applyTexture(sc.mesh, tex, t.aspect, SCREEN_WIDTH_M);
  }
  const g = t.canvas.getContext('2d');
  g.fillStyle = '#0e0e12'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#dcdcdc'; g.font = `${fontPx}px Menlo, Monaco, "DejaVu Sans Mono", monospace`; g.textBaseline = 'top';
  const lines = text.split('\n');
  for (let i = 0; i < Math.min(rows, lines.length); i++) g.fillText(lines[i], 2, i * lineH + 2);
  t.tex.needsUpdate = true;
}
function applyTexture(mesh, tex, aspect, width = null) {
  mesh.material.map = tex; mesh.material.color.set(0xffffff); mesh.material.needsUpdate = true;
  if (width) {
    const h = width / aspect;
    mesh.geometry.dispose(); mesh.geometry = new THREE.PlaneGeometry(width, h);
    if (mesh.children[0]) { mesh.children[0].geometry.dispose(); mesh.children[0].geometry = new THREE.PlaneGeometry(width + 0.04, h + 0.04); }
    if (mesh.children[1]) mesh.children[1].position.y = h / 2 + 0.05;
    if (mesh.children[2]) mesh.children[2].position.y = h / 2 + 0.05 + 0.035 + 0.05 + 0.02;
  }
}

// ── the bubbles (a sunflower) ──────────────────────────────────────────────
let world = null;
let selected = null;
const flowers = new Map();   // name → { group, circle, label, agent, color, target, phase, speech, title, talking, talkText }
const panels = [];           // the selected agent's mosaic
const screens = [];          // open windows, big: { wid, mesh, handles, kind, loading, at, aspectSet, focused, agent, color }
// Where you put a screen (position in root space, scale) is remembered per agent + window and used when it is opened again.
const screenMemory = new Map();
try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem('las-spaces-screens') || '{}'))) screenMemory.set(k, v); } catch { /* fresh */ }
function rememberScreen(sc) {
  screenMemory.set(`${sc.agent}:${sc.wid}`, { p: sc.mesh.position.toArray(), s: sc.mesh.scale.x });
  try { localStorage.setItem('las-spaces-screens', JSON.stringify(Object.fromEntries([...screenMemory].slice(-200)))); } catch { /* ignore */ }
}
let activeScreen = null;
const hoverables = [];
let hovered = null;

function agentWindows(agent) {
  if (!world || !agent.space) return [];
  const space = world.displays[0].spaces.find((s) => s.id === agent.space);
  if (!space) return [];
  const terms = space.windows.filter((w) => w.kind === 'terminal');
  return [...terms.filter((w) => w.session), ...terms.filter((w) => !w.session), ...space.windows.filter((w) => w.kind === 'browser')].slice(0, 10);
}

function makeFlower(agent) {
  const color = agent.color || '#90c060';
  const group = new THREE.Group();
  const circle = new THREE.Mesh(new THREE.PlaneGeometry(CLOUD.bubbleR * 2, CLOUD.bubbleR * 2), new THREE.MeshBasicMaterial({ map: bubbleFaceTexture(agent.name, color), transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
  circle.userData = { action: 'agent', name: agent.name, label: agent.name };
  group.add(circle); hoverables.push(circle);
  const label = { visible: true };   // the name lives inside the circle now
  const f = { group, circle, label, agent, color, target: new THREE.Vector3(), vel: new THREE.Vector3(), r: CLOUD.r, phase: Math.random() * Math.PI * 2, speech: null, title: null, talking: false, fresh: true };
  flowers.set(agent.name, f);
  root.add(group);
  return f;
}

/** The sunflower's center is your gaze (smoothed, both axes). */
function cloudCenter() { return { az: gazeAz, el: gazeEl }; }
function mosaicCenter() { return { az: mosaicAz, el: 0 }; }
let mosaicAz = 0;   // the mosaic stays where the agent was selected (it does not follow the gaze)

/** What occupies the middle of the view, as angular boxes around the viewer: open screens, the keyboard, the mosaic. */
function obstacles() {
  const list = [];
  const tmp = new THREE.Vector3();
  const angOf = (obj) => { obj.getWorldPosition(tmp); tmp.sub(viewerWorld); const d = tmp.length() || 1; return { az: Math.atan2(tmp.x, -tmp.z), el: Math.asin(THREE.MathUtils.clamp(tmp.y / d, -1, 1)), d }; };
  for (const sc of screens) {
    const g = sc.mesh.geometry.parameters, a = angOf(sc.mesh), k = root.scale.x;
    list.push({ az: a.az, el: a.el, hAz: Math.atan((g.width * sc.mesh.scale.x * k / 2) / a.d) + CLOUD.margin, hEl: Math.atan((g.height * sc.mesh.scale.y * k / 2) / a.d) + CLOUD.margin });
  }
  if (keyboard && activeScreen) { const a = angOf(keyboard.group); list.push({ az: a.az, el: a.el - 0.08, hAz: Math.atan(0.6 * root.scale.x / a.d) + CLOUD.margin, hEl: Math.atan(0.22 * root.scale.x / a.d) + CLOUD.margin }); }
  if (panels.length) { const c = mosaicCenter(), k = panels[0].count <= 4 ? 1 : 1.18; list.push({ az: c.az, el: c.el + 0.03, hAz: MOSAIC.az * k + 0.16, hEl: MOSAIC.el * k + 0.2 }); }
  return list;
}
/** Push a direction out of every obstacle box it falls in, to the box's rim along the line from the box center. */
function avoid(az, el, obs) {
  for (let pass = 0; pass < 3; pass++) {
    for (const o of obs) {
      let dAz = az - o.az; dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));
      const dEl = el - o.el;
      if (Math.abs(dAz) >= o.hAz || Math.abs(dEl) >= o.hEl) continue;
      const nx = dAz / o.hAz, ny = dEl / o.hEl, len = Math.hypot(nx, ny) || 1e-3;
      const ux = nx / len, uy = ny / len;
      const t = 1 / Math.max(Math.abs(ux), Math.abs(uy));   // to the rim of the unit box along (ux, uy)
      az = o.az + ux * t * o.hAz + ux * 0.03;
      el = o.el + uy * t * o.hEl + uy * 0.03;
    }
  }
  return { az, el };
}

/** Sunflower targets, every frame (cheap): seed i at r = step·√i, angle i·golden, around the gaze, flowing around obstacles. */
function layoutCloud() {
  const names = [...flowers.keys()].sort();
  const order = selected ? [selected, ...names.filter((n) => n !== selected)] : names;
  const c = cloudCenter(), obs = obstacles();
  order.forEach((n, i) => {
    const f = flowers.get(n);
    if (n === selected) { f.r = MOSAIC.r - 0.05; f.target.copy(onSphere(mosaicCenter().az, 0, f.r)); return; }
    const k = selected ? i : i + 1;                   // with nothing selected, no seed sits dead center
    const rr = CLOUD.step * Math.sqrt(k), th = k * GOLDEN;
    const a = avoid(c.az + rr * Math.cos(th), c.el + rr * Math.sin(th), obs);
    f.r = f.talking ? CLOUD.r - 0.5 : CLOUD.r;         // a talking agent comes closer
    f.target.copy(onSphere(a.az, a.el, f.r));
  });
}

function setSelected(name) {
  selected = name;
  for (const [n, f] of flowers) {
    const isSel = n === name;
    f.circle.visible = !isSel; f.label.visible = !isSel;
    if (f.title) { f.group.remove(f.title); disposeObject(f.title); unhover(f.title); f.title = null; }
    if (isSel) {
      const title = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.11), new THREE.MeshBasicMaterial({ map: textTexture(n, { width: 1024, height: 128, bg: f.color, fg: ink(f.color), font: 'bold 64px -apple-system, system-ui, sans-serif', align: 'center' }) }));
      title.position.set(0, MOSAIC.r * Math.sin(MOSAIC.el) + PANEL_H / 2 + 0.12, 0);
      title.userData = { action: 'agent', name: n, label: n };
      f.group.add(title); hoverables.push(title); f.title = title;
    }
  }
}

function clearPanels() {
  for (const p of panels) { root.remove(p.mesh); root.remove(p.label); disposeObject(p.mesh); disposeObject(p.label); unhover(p.mesh); }
  panels.length = 0;
}
function placePanel(p) {
  const a = -Math.PI / 2 + (p.index / Math.max(p.count, 1)) * Math.PI * 2;
  const k = p.count <= 4 ? 1 : 1.18, c = mosaicCenter();
  const az = c.az + Math.cos(a) * MOSAIC.az * k, el = c.el - Math.sin(a) * MOSAIC.el * k;
  place(p.mesh, az, el, MOSAIC.r);
  place(p.label, az, el - (PANEL_H / 2 + LABEL_H / 2 + 0.005) / MOSAIC.r, MOSAIC.r);
}
function buildMosaic() {
  clearPanels();
  const f = selected && flowers.get(selected);
  if (!f) return;
  const wins = agentWindows(f.agent);
  wins.forEach((win, i) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    mesh.userData = { action: 'window', wid: win.wid, label: win.title || win.app, kind: win.kind };
    const labelText = win.session ? `${win.session.runtime} — ${win.title}` : (win.title || win.app);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, LABEL_H), new THREE.MeshBasicMaterial({ map: textTexture(labelText, { width: 1024, height: 92, fg: win.kind === 'terminal' ? '#cfe8ff' : '#e8e8e8', font: '30px -apple-system, system-ui, sans-serif' }), transparent: true }));
    root.add(mesh); root.add(label); hoverables.push(mesh);
    const p = { mesh, label, wid: win.wid, kind: win.kind, loading: false, at: 0, index: i, count: wins.length };
    const tt = win.kind === 'terminal' ? termTex.get(win.wid) : null;
    if (tt) applyTexture(mesh, tt.tex, tt.aspect);
    placePanel(p);
    panels.push(p);
  });
}
function placeMosaic() { for (const p of panels) placePanel(p); }

function buildWorld() {
  if (!world || !world.displays[0]) return;
  if (!world.agents.length && flowers.size) return;   // a hiccup, never a reason to drop every bubble
  const seen = new Set();
  for (const a of world.agents) { seen.add(a.name); const f = flowers.get(a.name); if (f) f.agent = a; else makeFlower(a); }
  for (const [name, f] of flowers) if (!seen.has(name)) { root.remove(f.group); disposeObject(f.group); unhover(f.circle); if (f.title) unhover(f.title); flowers.delete(name); }
  if (selected && !flowers.has(selected)) selected = null;
  setSelected(selected);
  buildMosaic();
  for (const sc of [...screens]) if (!agentWindowsAll().has(sc.wid)) closeScreen(sc);
  hud.textContent = `LAS Spaces — ${flowers.size} agents · ${renderer.xr.isPresenting ? 'in VR' : 'flat (press Enter VR)'} · bubble: select · tile: open a screen · grip moves a screen / the keyboard / everything, both grips resize it · trigger clicks, stick scrolls · nothing: collapse · A/B: close screen`;
}
function agentWindowsAll() { const s = new Set(); if (world) for (const d of world.displays) for (const sp of d.spaces) for (const w of sp.windows) s.add(w.wid); return s; }

function select(name) {
  mosaicAz = gazeAz;
  setSelected(selected === name ? null : name);
  buildMosaic();
}
function collapse() {
  for (const sc of [...screens]) closeScreen(sc);
  setSelected(null);
  buildMosaic();
}

// ── speech: the talking agent comes closer, inflates, pulses, with its words ──
function speech(agentName, text, phase) {
  const f = flowers.get(agentName);
  if (!f) return;
  if (f.speech) { f.group.remove(f.speech); disposeObject(f.speech); f.speech = null; }
  f.talking = phase === 'playing';
  if (!f.talking) return;
  const { tex, aspect } = bubbleTexture(text, f.color);
  const w = 0.6, h = w / aspect;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  const base = f.title ? f.title.position.y + 0.06 : CLOUD.bubbleR * 1.6;
  mesh.position.set(0, base + h / 2 + 0.04, 0.02);
  f.group.add(mesh); f.speech = mesh;
}

// ── screens: open windows, big, movable, resizable, several at once ────────
function openScreen(panel, label) {
  const existing = screens.find((s) => s.wid === panel.wid);
  if (existing) { activeScreen = existing; return; }
  while (screens.length >= MAX_SCREENS) closeScreen(screens[0]);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_WIDTH_M, SCREEN_WIDTH_M * 9 / 16), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  mesh.userData = { action: 'screen', wid: panel.wid, label, kind: panel.kind };
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_WIDTH_M + 0.04, SCREEN_WIDTH_M * 9 / 16 + 0.04), new THREE.MeshBasicMaterial({ color: 0x8ab4ff }));
  frame.position.z = -0.003; mesh.add(frame);
  const title = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_WIDTH_M, 0.07), new THREE.MeshBasicMaterial({ map: textTexture(label, { width: 1536, height: 64, font: '34px -apple-system, system-ui, sans-serif', fg: '#fff' }), transparent: true }));
  title.position.y = SCREEN_WIDTH_M * 9 / 32 + 0.05; mesh.add(title);
  const agentName = selected || '', color = (selected && flowers.get(selected) && flowers.get(selected).color) || '#3a3a44';
  const bar = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_WIDTH_M, 0.1), new THREE.MeshBasicMaterial({ map: textTexture(agentName, { width: 1536, height: 96, bg: color, fg: ink(color), font: 'bold 60px -apple-system, system-ui, sans-serif', align: 'center' }) }));
  bar.position.y = title.position.y + 0.035 + 0.05 + 0.02; mesh.add(bar);
  const handles = [];
  root.add(mesh); hoverables.push(mesh);
  const sc = { wid: panel.wid, mesh, handles, kind: panel.kind, loading: false, at: 0, aspectSet: false, focused: false, agent: agentName, color };
  screens.push(sc); activeScreen = sc;
  const mem = screenMemory.get(`${agentName}:${panel.wid}`);
  if (mem) { mesh.position.fromArray(mem.p); mesh.scale.setScalar(mem.s || 1); mesh.lookAt(viewerWorld); }
  else place(mesh, headYaw + (screens.length - 1) * 0.5 - (screens.length - 1) * 0.25, headPitch * 0.5, SCREEN_DIST);   // where you look, aside of ones already open
  const tt = panel.kind === 'terminal' ? termTex.get(panel.wid) : null;
  if (tt) { applyTexture(mesh, tt.tex, tt.aspect, SCREEN_WIDTH_M); sc.aspectSet = true; }
  if (!keyboard) buildKeyboard();
}
function closeScreen(sc) {
  const i = screens.indexOf(sc); if (i !== -1) screens.splice(i, 1);
  root.remove(sc.mesh);
  for (const o of [sc.mesh, ...sc.handles]) unhover(o);
  disposeObject(sc.mesh);
  if (hovered === sc.mesh) setHovered(null);
  if (activeScreen === sc) activeScreen = screens[screens.length - 1] || null;
  if (!screens.length) destroyKeyboard();
}
async function ensureFocused(sc) {
  if (!sc || sc.focused) return Boolean(sc);
  const r = await post(`/window/${sc.wid}/focus`);
  sc.focused = Boolean(r && r.ok);
  report({ act: 'focus-for-input', wid: sc.wid, result: r });
  return sc.focused;
}
const loader = new THREE.TextureLoader();
function refreshScreen(sc) {
  if (sc.loading || performance.now() - sc.at < 200) return;
  if (sc.kind === 'terminal' && termTex.has(sc.wid)) return;
  sc.loading = true;
  const hi = sc.mesh.scale.x >= 1.15;
  loader.load(`/thumb/${sc.wid}?w=${hi ? SCREEN_W_HI : SCREEN_W}&live=1${hi ? '&hi=1' : ''}&t=${Date.now()}`, (tex) => {
    if (!screens.includes(sc)) { tex.dispose(); return; }
    tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const old = sc.mesh.material.map;
    if (!sc.aspectSet && tex.image && tex.image.width) { sc.aspectSet = true; applyTexture(sc.mesh, tex, tex.image.width / tex.image.height, SCREEN_WIDTH_M); }
    else { sc.mesh.material.map = tex; sc.mesh.material.color.set(0xffffff); sc.mesh.material.needsUpdate = true; }
    if (old && old !== tex) old.dispose();
    sc.loading = false; sc.at = performance.now();
  }, undefined, () => { sc.loading = false; sc.at = performance.now(); });
}
function refresh(panel, live) {
  if (panel.loading) return;
  panel.loading = true;
  loader.load(`/thumb/${panel.wid}?w=${live ? LIVE_W : THUMB_W}${live ? '&live=1' : ''}&t=${Date.now()}`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const old = panel.mesh.material.map;
    panel.mesh.material.map = tex; panel.mesh.material.color.set(0xffffff); panel.mesh.material.needsUpdate = true;
    if (old) old.dispose();
    panel.loading = false; panel.at = performance.now();
  }, undefined, () => { panel.loading = false; panel.at = performance.now(); });
}
setInterval(() => {
  for (const sc of screens) refreshScreen(sc);
  const now = performance.now();
  for (const p of panels) {
    if (p.kind === 'terminal' && termTex.has(p.wid)) continue;
    const live = hovered && hovered.userData.wid === p.wid;
    if (now - p.at > (live ? 350 : 3000)) refresh(p, live);
  }
}, 200);

// ── the keyboard: under the active screen ──────────────────────────────────
const KEY_ROWS = [
  [['`', '~'], ['1', '!'], ['2', '@'], ['3', '#'], ['4', '$'], ['5', '%'], ['6', '^'], ['7', '&'], ['8', '*'], ['9', '('], ['0', ')'], ['-', '_'], ['=', '+'], { key: 'backspace', label: '⌫', w: 1.6 }],
  [{ key: 'tab', label: 'Tab', w: 1.4 }, 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', ['[', '{'], [']', '}'], ['\\', '|']],
  [{ mod: 'ctrl', label: 'Ctrl', w: 1.6 }, 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', [';', ':'], ["'", '"'], { key: 'enter', label: '⏎', w: 1.8 }],
  [{ mod: 'shift', label: '⇧', w: 2.0 }, 'z', 'x', 'c', 'v', 'b', 'n', 'm', [',', '<'], ['.', '>'], ['/', '?'], { key: 'up', label: '↑' }, { key: 'escape', label: 'Esc', w: 1.2 }],
  [{ mod: 'command', label: '⌘', w: 1.6 }, { text: ' ', label: 'space', w: 7 }, { key: 'left', label: '←' }, { key: 'down', label: '↓' }, { key: 'right', label: '→' }, { text: '/', label: '/' }],
];
const KEY_W = 0.075, KEY_H = 0.07, KEY_GAP = 0.008;
let keyboard = null;
const mods = { shift: false, ctrl: false, command: false };
function keyLabel(def) { if (typeof def === 'string') return mods.shift ? def.toUpperCase() : def; if (Array.isArray(def)) return mods.shift ? def[1] : def[0]; return def.label; }
function buildKeyboard() {
  destroyKeyboard();
  const group = new THREE.Group(), keys = [];
  const totalW = Math.max(...KEY_ROWS.map((r) => r.reduce((w, d) => w + ((d && d.w) || 1) * KEY_W + KEY_GAP, 0)));
  KEY_ROWS.forEach((row, r) => {
    let x = -totalW / 2;
    for (const def of row) {
      const w = ((def && def.w) || 1) * KEY_W;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w - KEY_GAP, KEY_H - KEY_GAP), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      mesh.position.set(x + w / 2, -r * KEY_H, 0);
      mesh.userData = { action: 'key', def, label: keyLabel(def) };
      group.add(mesh); hoverables.push(mesh); keys.push({ mesh, def });
      x += w + KEY_GAP;
    }
  });
  keyboard = { group, keys };
  paintKeys();
  root.add(group);
}
function paintKeys() {
  if (!keyboard) return;
  for (const { mesh, def } of keyboard.keys) {
    const isMod = def && def.mod, on = isMod && mods[def.mod], label = keyLabel(def);
    mesh.userData.label = label;
    const old = mesh.material.map;
    mesh.material.map = textTexture(label, { width: 192, height: 128, bg: on ? '#8ab4ff' : isMod ? '#3a3a48' : '#2a2a34', fg: on ? '#141414' : '#f0f0f0', font: `${label.length > 2 ? 40 : 56}px -apple-system, system-ui, sans-serif`, align: 'center', pad: 8 });
    mesh.material.needsUpdate = true;
    if (old) old.dispose();
  }
}
function destroyKeyboard() {
  if (!keyboard) return;
  root.remove(keyboard.group);
  for (const { mesh } of keyboard.keys) unhover(mesh);
  disposeObject(keyboard.group);
  keyboard = null;
}
function placeKeyboard() {
  if (!keyboard || !activeScreen || keyboard.detached) return;   // once grabbed, the keyboard stays where you left it
  const sc = activeScreen, g = sc.mesh.geometry.parameters;
  keyboard.group.position.copy(sc.mesh.position);
  keyboard.group.quaternion.copy(sc.mesh.quaternion);
  keyboard.group.translateY(-(g.height / 2) * sc.mesh.scale.x - 0.12);
  keyboard.group.translateZ(0.05);
  keyboard.group.rotateX(-0.35);
}
async function pressKey(u) {
  const sc = activeScreen; if (!sc) return;
  const def = u.def;
  if (def && def.mod) { mods[def.mod] = !mods[def.mod]; paintKeys(); return; }
  if (!(await ensureFocused(sc))) return;
  const active = ['shift', 'ctrl', 'command'].filter((m) => mods[m]);
  const text = typeof def === 'string' ? (mods.shift ? def.toUpperCase() : def) : Array.isArray(def) ? (mods.shift ? def[1] : def[0]) : def.text;
  const modsOut = active.map((m) => (m === 'ctrl' ? 'control' : m));
  if (def && def.key) post('/input', { wid: sc.wid, type: 'key', key: def.key, mods: modsOut });
  else if (mods.ctrl || mods.command) post('/input', { wid: sc.wid, type: 'key', key: String(text).toLowerCase(), mods: modsOut });
  else post('/input', { wid: sc.wid, type: 'type', text });
  if (active.length) { mods.shift = mods.ctrl = mods.command = false; paintKeys(); }
}

// ── pointing: XR controllers, and the mouse when flat ──────────────────────
const raycaster = new THREE.Raycaster();
const tmpM = new THREE.Matrix4();
function pickHit(controller) {
  tmpM.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpM);
  return raycaster.intersectObjects(hoverables, false)[0] || null;
}
const uvOf = (hit) => (hit && hit.uv ? { u: hit.uv.x, v: 1 - hit.uv.y } : null);
const screenOf = (obj) => screens.find((s) => s.mesh === obj || s.handles.includes(obj));
const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x8ab4ff }));
  line.scale.z = 4; c.add(line);
  c.addEventListener('selectstart', () => { const hit = pickHit(c); act(hit ? hit.object : null, uvOf(hit), c); });
  c.addEventListener('squeezestart', () => startGrab(c));
  c.addEventListener('squeezeend', () => endGrab(c));
  scene.add(c);
  return c;
});
const mouse = new THREE.Vector2(-2, -2);
window.addEventListener('pointermove', (e) => { mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1); });
window.addEventListener('click', () => { if (renderer.xr.isPresenting) return; raycaster.setFromCamera(mouse, camera); const hit = raycaster.intersectObjects(hoverables, false)[0]; act(hit ? hit.object : null, uvOf(hit), null); });
window.addEventListener('wheel', (e) => { if (renderer.xr.isPresenting) return; const sc = hovered && screenOf(hovered); if (!sc || !sc.focused) return; raycaster.setFromCamera(mouse, camera); const uv = uvOf(raycaster.intersectObject(sc.mesh, false)[0]); if (uv) post('/input', { wid: sc.wid, type: 'scroll', ...uv, dx: e.deltaX, dy: e.deltaY }); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (activeScreen) closeScreen(activeScreen); else collapse(); } });

async function act(obj, uv, controller) {
  if (!obj) { collapse(); report({ act: 'collapse' }); return; }
  const u = obj.userData;
  if (u.action === 'screen') { const sc = screenOf(obj); activeScreen = sc; if (uv && await ensureFocused(sc)) post('/input', { wid: sc.wid, type: 'click', ...uv }); return; }
  if (u.action === 'key') { pressKey(u); return; }
  if (u.action === 'agent') { select(u.name); report({ act: 'select', label: u.name }); return; }
  if (u.action === 'window') { const panel = panels.find((p) => p.wid === u.wid); if (panel) openScreen(panel, u.label); report({ act: 'open', label: u.label }); }
}

// grips: on a screen → move it (two grips → scale it); on a corner → resize; on nothing → move the display (two → scale it)
const grabs = new Map();   // controller → { kind: 'root'|'screen', screen, start, objStart }
let twoHand = null;
function ctrlPos(c) { return new THREE.Vector3().setFromMatrixPosition(c.matrixWorld); }
function grabTargetOf(hit) {
  if (!hit) return { kind: 'root', obj: root };
  const sc = screenOf(hit.object);
  if (sc) { activeScreen = sc; return { kind: 'screen', obj: sc.mesh, screen: sc }; }
  if (keyboard && hit.object.userData.action === 'key') { keyboard.detached = true; return { kind: 'keyboard', obj: keyboard.group }; }
  return { kind: 'root', obj: root };
}
function startGrab(controller) {
  const t = grabTargetOf(pickHit(controller));
  const { kind, obj: target, screen: sc = null } = t;
  grabs.set(controller, { kind, screen: sc, obj: target, start: ctrlPos(controller), objStart: target.position.clone() });
  const both = [...grabs.values()];
  if (both.length === 2) {
    const same = both[0].obj === both[1].obj;
    const [a, b] = [...grabs.keys()].map(ctrlPos);
    const obj = same ? target : null;
    twoHand = obj ? { obj, startDist: Math.max(0.05, a.distanceTo(b)), startScale: obj.scale.x, startPos: obj.position.clone(), startMid: a.clone().add(b).multiplyScalar(0.5) } : null;
  }
}
function endGrab(controller) {
  const g = grabs.get(controller);
  if (g && g.kind === 'screen') rememberScreen(g.screen);
  grabs.delete(controller); twoHand = null;
  for (const [c, g] of grabs) { g.start = ctrlPos(c); g.objStart = g.obj.position.clone(); }
  saveRoot();
}
function updateGrabs() {
  if (twoHand && grabs.size === 2) {
    const [a, b] = [...grabs.keys()].map(ctrlPos);
    const sc = THREE.MathUtils.clamp(twoHand.startScale * a.distanceTo(b) / twoHand.startDist, twoHand.obj === root ? 0.3 : 0.4, twoHand.obj === root ? 3 : 3.5);
    twoHand.obj.scale.setScalar(sc);
    if (twoHand.obj !== root) return;
    const mid = a.add(b).multiplyScalar(0.5);
    root.position.copy(twoHand.startPos).sub(twoHand.startMid).multiplyScalar(sc / twoHand.startScale).add(twoHand.startMid).add(mid.sub(twoHand.startMid));
    return;
  }
  for (const [c, g] of grabs) {
    const delta = ctrlPos(c).sub(g.start);
    if (g.kind === 'root') root.position.copy(g.objStart).add(delta);
    else { g.obj.position.copy(g.objStart).add(delta.divideScalar(root.scale.x)); g.obj.lookAt(viewerWorld); if (g.kind === 'keyboard') g.obj.rotateX(-0.35); }
  }
}

const padState = new Map();
let lastMoveAt = 0, lastScrollAt = 0;
function pollGamepads() {
  const session = renderer.xr.getSession();
  if (!session) return;
  const now = performance.now();
  for (const src of session.inputSources) {
    const gp = src.gamepad; if (!gp) continue;
    const prev = padState.get(src) || {};
    const b4 = gp.buttons[4] && gp.buttons[4].pressed, b5 = gp.buttons[5] && gp.buttons[5].pressed;
    if ((b4 && !prev.b4) || (b5 && !prev.b5)) { if (activeScreen) closeScreen(activeScreen); }
    padState.set(src, { b4, b5 });
    const y = gp.axes[3] || 0;
    if (Math.abs(y) > 0.3 && now - lastScrollAt > 90) {
      const c = controllers[src.handedness === 'left' ? 0 : 1]; const hit = c && pickHit(c); const sc = hit && screenOf(hit.object);
      if (sc && sc.focused && hit.object === sc.mesh) { lastScrollAt = now; post('/input', { wid: sc.wid, type: 'scroll', ...uvOf(hit), dx: 0, dy: y * 60 }); }
    }
  }
  if (now - lastMoveAt > 80) {
    for (const c of controllers) { const hit = pickHit(c); const sc = hit && screenOf(hit.object); if (sc && sc.focused && hit.object === sc.mesh) { lastMoveAt = now; post('/input', { wid: sc.wid, type: 'move', ...uvOf(hit) }); break; } }
  }
}

function setHovered(obj) {
  // No overlay: a hovered key or tile grows a little; bubbles grow in the frame loop.
  if (hovered && hovered.userData && (hovered.userData.action === 'key' || hovered.userData.action === 'window')) hovered.scale.setScalar(1);
  hovered = obj;
  if (obj && obj.userData && (obj.userData.action === 'key' || obj.userData.action === 'window')) obj.scale.setScalar(1.08);
}

// ── the molecules: each bubble is pulled to its seed and pushed off its neighbours ──
// A spring to the seed, damping, a soft repulsion inside 1.6 radii and a hard
// collision at touching distance (so bubbles never overlap: they bump), then
// the position is put back on the bubble's sphere around the viewer. A big
// (talking, hovered) bubble pushes the others away; small ones pack closer.
const _d = new THREE.Vector3(), _acc = new THREE.Vector3();
function moleculeStep(dt, t) {
  const list = [...flowers.values()].filter((f) => f.circle.visible);
  for (const f of list) {
    if (f.fresh) { f.group.position.copy(f.target); f.fresh = false; }
    _acc.copy(f.target).sub(f.group.position).multiplyScalar(CLOUD.attract);
    _acc.y += Math.sin(t * 1.3 + f.phase) * 0.06;                        // a gentle bob
    _acc.addScaledVector(f.vel, -CLOUD.damp);
    f.vel.addScaledVector(_acc, dt);
  }
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    _d.copy(a.group.position).sub(b.group.position);
    const dist = _d.length() || 1e-4;
    const minDist = CLOUD.bubbleR * (a.circle.scale.x + b.circle.scale.x) * CLOUD.gap;
    if (dist < minDist * 1.6) {
      _d.divideScalar(dist);
      const push = CLOUD.repel * (1 - dist / (minDist * 1.6));
      a.vel.addScaledVector(_d, push * dt); b.vel.addScaledVector(_d, -push * dt);
      if (dist < minDist) {                                                 // touching: separate now, and bounce
        const ov = (minDist - dist) / 2;
        a.group.position.addScaledVector(_d, ov); b.group.position.addScaledVector(_d, -ov);
        const vn = a.vel.dot(_d) - b.vel.dot(_d);
        if (vn < 0) { a.vel.addScaledVector(_d, -vn * 0.6); b.vel.addScaledVector(_d, vn * 0.6); }
      }
    }
  }
  for (const f of list) {
    f.group.position.addScaledVector(f.vel, dt);
    _d.copy(f.group.position).sub(viewer);                                  // back onto its sphere
    const len = _d.length() || 1;
    f.group.position.copy(viewer).addScaledVector(_d, (f.r / root.scale.x) / len);
  }
}

// ── the frame ──────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
const fwd = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  pollGamepads();
  if (rebase && renderer.xr.isPresenting && ++rebaseFrames > 5 && rebaseToHead()) rebase = false;
  const eye = headY == null ? EYE_Y : headY;
  viewerWorld.set(0, eye, 0); viewer.copy(viewerWorld); root.worldToLocal(viewer);
  // where you look, as an azimuth in root space; the bubbles follow it slowly (a swarm, not a HUD)
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
  const rootYaw = new THREE.Euler().setFromQuaternion(root.quaternion, 'YXZ').y;
  headYaw = Math.atan2(fwd.x, -fwd.z) - rootYaw;
  headPitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
  let d = headYaw - gazeAz; d = Math.atan2(Math.sin(d), Math.cos(d));
  gazeAz += d * CLOUD.follow;
  gazeEl += (THREE.MathUtils.clamp(headPitch, -0.7, 0.7) - gazeEl) * CLOUD.follow;
  updateGrabs();
  layoutCloud();
  placeMosaic();
  placeKeyboard();
  const t = clock.getElapsedTime();
  const dt = Math.min(0.05, clock.getDelta() || 0.016);
  for (const f of flowers.values()) {
    const base = f.talking ? 1.5 + Math.sin(t * 6) * 0.12 : 1;         // inflated and pulsing while it talks
    f.circle.scale.setScalar(THREE.MathUtils.lerp(f.circle.scale.x, hovered === f.circle ? base * 1.12 : base, 0.2));
  }
  moleculeStep(dt, t);
  for (const f of flowers.values()) { if (!f.circle.visible) f.group.position.lerp(f.target, 0.1); f.group.lookAt(viewerWorld); }
  let h = null;
  if (renderer.xr.isPresenting) { for (const c of controllers) h = (pickHit(c) || {}).object || h; }
  else { raycaster.setFromCamera(mouse, camera); const hit = raycaster.intersectObjects(hoverables, false)[0]; h = hit ? hit.object : null; }
  if (h !== hovered) setHovered(h);
  renderer.render(scene, camera);
});
renderer.xr.addEventListener('sessionstart', () => { report({ sessionStarted: true }); rebase = true; rebaseFrames = 0; buildWorld(); });
renderer.xr.addEventListener('sessionend', () => { report({ sessionEnded: true }); headY = null; root.position.y = 0; buildWorld(); });

// ── the world: first over HTTP, then live over the socket ──────────────────
fetch('/world').then((r) => r.json()).then((w) => { world = w; buildWorld(); }).catch(() => {});
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.type === 'world') { world = d.world; buildWorld(); }
    else if (d.type === 'text') drawTerminal(d.wid, d);
    else if (d.type === 'speech') speech(d.agent, d.text, d.phase);
  };
  ws.onclose = () => setTimeout(connect, 2000);
}
connect();
report({ loaded: true, secure: window.isSecureContext, xr: Boolean(navigator.xr) });
