// LAS Spaces — the immersive view (WebXR + three.js). See
// docs/plans/2026-10-29-quest-spaces.md.
//
// A view of the LAS AGENTS: each agent is a BUBBLE (a sphere in its color
// with its name) and the bubbles float in front of you like a flower —
// the SELECTED agent at the center, the others as petals around it.
// Selecting an agent (trigger on its bubble) moves it to the center and
// EXPANDS it: its windows — the terminals of its sessions first, then the
// other terminals and the browser windows on its Space — form a MOSAIC of
// panels around it (terminals are live text, browsers live pixels).
// Trigger on a panel puts it on the STAGE, big, and focuses that window on
// the Mac. On the stage the controller IS a pointer: moving it moves the
// Mac's pointer in that window, the trigger clicks, the thumbstick scrolls;
// a VIRTUAL KEYBOARD under the stage types into it (server /input → real
// CGEvents), and the physical keyboard works as ever. A/X or B/Y closes. When an agent speaks, a SPEECH BUBBLE with its
// words rises from its sphere while the voice plays (fed by the widget
// app through the server's /speech). Outside VR the same scene renders
// flat with a mouse, which is how it is checked from the Mac.
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

const hud = document.getElementById('hud');
const report = (data) => fetch('/hello', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: Date.now(), vr: true, ...data }) }).catch(() => {});
window.addEventListener('error', (e) => report({ error: String(e.message), at: `${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => report({ error: 'unhandled: ' + String(e.reason && e.reason.message || e.reason) }));
const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));

// ── layout (meters) ────────────────────────────────────────────────────────
const EYE_Y = 1.45;
const FLOWER = { z: -1.9, petalR: 0.78, petalROpen: 1.08, bubbleR: 0.12 };
const PANEL_W = 0.5, PANEL_H = PANEL_W * 9 / 16, LABEL_H = 0.045, MOSAIC_R = 0.66;
const THUMB_W = 400, LIVE_W = 1100, STAGE_W = 1500, STAGE_WIDTH_M = 1.6, STAGE_DIST = 1.35;

// ── renderer / scene ───────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f0f14);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 60);
camera.position.set(0, EYE_Y, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 0.8); sun.position.set(1, 3, 2); scene.add(sun);
const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.MeshBasicMaterial({ color: 0x14141a }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
const grid = new THREE.GridHelper(12, 24, 0x262630, 0x1c1c24); grid.position.y = 0.001; scene.add(grid);
window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });

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
/** A speech bubble: wrapped text in the agent's color with a tail at the bottom. Returns { tex, aspect }. */
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
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
const ink = (hex) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || ''); if (!m) return '#141414'; const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45 ? '#f4f4f4' : '#141414'; };

// ── terminal text → texture ────────────────────────────────────────────────
const termTex = new Map();   // wid → { tex, canvas, aspect }
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
    if (stage && stage.wid === wid) applyTexture(stage.mesh, tex, t.aspect, STAGE_WIDTH_M);
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
    if (stage && mesh === stage.mesh) placeHandles();
  }
}
function disposeObject(o) { o.traverse((c) => { if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); } if (c.geometry) c.geometry.dispose(); }); }

// ── the flower: agent bubbles ──────────────────────────────────────────────
let world = null;
let selected = null;        // agent name at the center, expanded
const flowers = new Map();  // name → { group, sphere, label, agent, target: Vector3, phase, speech }
const panels = [];          // the selected agent's mosaic: { mesh, label, wid, kind, loading, at }
const hoverables = [];      // meshes with userData.action
let hovered = null;

function agentWindows(agent) {
  if (!world || !agent.space) return [];
  const space = world.displays[0].spaces.find((s) => s.id === agent.space);
  if (!space) return [];
  const terms = space.windows.filter((w) => w.kind === 'terminal');
  return [...terms.filter((w) => w.session), ...terms.filter((w) => !w.session), ...space.windows.filter((w) => w.kind === 'browser')].slice(0, 10);
}

function makeFlower(agent) {
  const color = new THREE.Color(agent.color || '#90c060');
  const group = new THREE.Group();
  // A plain circle in the widget's color (no shading: the color IS the identity).
  const sphere = new THREE.Mesh(new THREE.CircleGeometry(FLOWER.bubbleR, 48), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  sphere.userData = { action: 'agent', name: agent.name, label: agent.name };
  group.add(sphere); hoverables.push(sphere);
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.07), new THREE.MeshBasicMaterial({ map: textTexture(agent.name, { width: 512, height: 84, fg: '#fff', font: 'bold 44px -apple-system, system-ui, sans-serif', align: 'center' }), transparent: true }));
  label.position.y = -FLOWER.bubbleR - 0.06;
  group.add(label);
  const f = { group, sphere, label, agent, color: agent.color || '#90c060', target: new THREE.Vector3(), phase: Math.random() * Math.PI * 2, speech: null, title: null };
  flowers.set(agent.name, f);
  scene.add(group);
  return f;
}

function layoutFlower() {
  const names = [...flowers.keys()].sort();
  const petals = names.filter((n) => n !== selected);
  const r = selected ? FLOWER.petalROpen : FLOWER.petalR;
  petals.forEach((n, i) => {
    const a = -Math.PI / 2 + (i / petals.length) * Math.PI * 2;   // from the top, clockwise
    flowers.get(n).target.set(Math.cos(a) * r, EYE_Y + Math.sin(a) * r * 0.78, FLOWER.z);
  });
  for (const [n, f] of flowers) {
    const isSel = n === selected;
    f.sphere.visible = !isSel; f.label.visible = !isSel;
    if (isSel) f.target.set(0, EYE_Y + 0.02, FLOWER.z + 0.1);   // the group stays as the anchor for its speech bubble
    if (f.title) { f.group.remove(f.title); disposeObject(f.title); const i = hoverables.indexOf(f.title); if (i !== -1) hoverables.splice(i, 1); f.title = null; }
    if (isSel) {
      const title = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.11), new THREE.MeshBasicMaterial({ map: textTexture(n, { width: 1024, height: 128, bg: f.color, fg: ink(f.color), font: 'bold 64px -apple-system, system-ui, sans-serif', align: 'center' }) }));
      title.position.set(0, MOSAIC_R * 0.72 + PANEL_H / 2 + 0.14, 0);
      title.userData = { action: 'agent', name: n, label: n };
      f.group.add(title); hoverables.push(title); f.title = title;
    }
  }
}

function clearPanels() {
  for (const p of panels) { scene.remove(p.mesh); scene.remove(p.label); disposeObject(p.mesh); disposeObject(p.label); const i = hoverables.indexOf(p.mesh); if (i !== -1) hoverables.splice(i, 1); }
  panels.length = 0;
}

/** The selected agent's windows as a mosaic ring around its bubble. */
function buildMosaic() {
  clearPanels();
  const f = selected && flowers.get(selected);
  if (!f) return;
  const wins = agentWindows(f.agent);
  const n = wins.length;
  wins.forEach((win, i) => {
    const a = -Math.PI / 2 + (i / Math.max(n, 1)) * Math.PI * 2;
    const rx = n <= 4 ? MOSAIC_R : MOSAIC_R + 0.12, ry = rx * 0.72;
    const x = Math.cos(a) * rx, y = EYE_Y + 0.02 + Math.sin(a) * ry, z = FLOWER.z + 0.05;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    mesh.position.set(x, y, z);
    mesh.userData = { action: 'window', wid: win.wid, label: win.title || win.app, kind: win.kind };
    const labelText = win.session ? `${win.session.runtime} — ${win.title}` : (win.title || win.app);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, LABEL_H), new THREE.MeshBasicMaterial({ map: textTexture(labelText, { width: 1024, height: 92, fg: win.kind === 'terminal' ? '#cfe8ff' : '#e8e8e8', font: '30px -apple-system, system-ui, sans-serif' }), transparent: true }));
    label.position.set(x, y - PANEL_H / 2 - LABEL_H / 2 - 0.005, z);
    scene.add(mesh); scene.add(label); hoverables.push(mesh);
    const p = { mesh, label, wid: win.wid, kind: win.kind, loading: false, at: 0 };
    const tt = win.kind === 'terminal' ? termTex.get(win.wid) : null;
    if (tt) applyTexture(mesh, tt.tex, tt.aspect);
    panels.push(p);
  });
}

function buildWorld() {
  if (!world || !world.displays[0]) return;
  const seen = new Set();
  for (const a of world.agents) {
    seen.add(a.name);
    const f = flowers.get(a.name);
    if (f) { f.agent = a; } else makeFlower(a);
  }
  for (const [name, f] of flowers) if (!seen.has(name)) { scene.remove(f.group); disposeObject(f.group); for (const o of [f.sphere, f.title]) { const i = hoverables.indexOf(o); if (i !== -1) hoverables.splice(i, 1); } flowers.delete(name); }
  if (selected && !flowers.has(selected)) selected = null;
  layoutFlower();
  buildMosaic();
  if (stage && !panels.some((p) => p.wid === stage.wid)) closeStage();
  hud.textContent = `LAS Spaces — ${flowers.size} agents · ${renderer.xr.isPresenting ? 'in VR' : 'flat (press Enter VR)'} · circle: select · tile: big · big view: trigger clicks, stick scrolls, grip a corner to resize, keys below · A/B: close`;
}

function select(name) {
  selected = selected === name ? null : name;
  closeStage();
  layoutFlower();
  buildMosaic();
}

// ── speech bubbles from the agents ─────────────────────────────────────────
function speech(agentName, text, phase) {
  const f = flowers.get(agentName);
  if (!f) return;
  if (f.speech) { f.group.remove(f.speech); disposeObject(f.speech); f.speech = null; }
  if (phase !== 'playing') return;
  const { tex, aspect } = bubbleTexture(text, f.agent.color || '#90c060');
  const w = 0.6, h = w / aspect;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  const base = f.title ? f.title.position.y + 0.06 : FLOWER.bubbleR;
  mesh.position.set(0, base + h / 2 + 0.04, 0.02);
  f.group.add(mesh); f.speech = mesh;
}

// ── the stage: one window, big, in front ───────────────────────────────────
let stage = null;
function openStage(panel, label) {
  closeStage();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(STAGE_WIDTH_M, STAGE_WIDTH_M * 9 / 16), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  mesh.position.set(0, EYE_Y + 0.02, -STAGE_DIST);
  mesh.userData = { action: 'stage', wid: panel.wid, label, kind: panel.kind };
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(STAGE_WIDTH_M + 0.04, STAGE_WIDTH_M * 9 / 16 + 0.04), new THREE.MeshBasicMaterial({ color: 0x8ab4ff }));
  frame.position.z = -0.003; mesh.add(frame);
  const title = new THREE.Mesh(new THREE.PlaneGeometry(STAGE_WIDTH_M, 0.07), new THREE.MeshBasicMaterial({ map: textTexture(label, { width: 1536, height: 64, font: '34px -apple-system, system-ui, sans-serif', fg: '#fff' }), transparent: true }));
  title.position.y = STAGE_WIDTH_M * 9 / 32 + 0.05; mesh.add(title);
  scene.add(mesh); hoverables.push(mesh);
  // Four corner handles: grip one and move the controller to resize (aspect kept).
  const handles = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => {
    const h = new THREE.Mesh(new THREE.CircleGeometry(0.035, 24), new THREE.MeshBasicMaterial({ color: 0x8ab4ff, side: THREE.DoubleSide }));
    h.userData = { action: 'resize', sx, sy, label: 'resize' };
    mesh.add(h); hoverables.push(h);
    return h;
  });
  stage = { wid: panel.wid, mesh, handles, kind: panel.kind, loading: false, at: 0, aspectSet: false, focused: false };
  placeHandles();
  buildKeyboard();
  const tt = panel.kind === 'terminal' ? termTex.get(panel.wid) : null;
  if (tt) { applyTexture(mesh, tt.tex, tt.aspect, STAGE_WIDTH_M); stage.aspectSet = true; }
}
function placeHandles() {
  if (!stage) return;
  const g = stage.mesh.geometry.parameters;
  for (const h of stage.handles) h.position.set(h.userData.sx * g.width / 2, h.userData.sy * g.height / 2, 0.004);
}
/** The Mac must have this window in front before any pointer or key reaches it — done once, on the first real interaction. */
async function ensureFocused() {
  if (!stage || stage.focused) return true;
  const r = await post(`/window/${stage.wid}/focus`);
  if (stage) stage.focused = Boolean(r && r.ok);
  report({ act: 'focus-for-input', wid: stage && stage.wid, result: r });
  return Boolean(r && r.ok);
}
function closeStage() {
  if (!stage) return;
  scene.remove(stage.mesh);
  for (const o of [stage.mesh, ...stage.handles]) { const i = hoverables.indexOf(o); if (i !== -1) hoverables.splice(i, 1); }
  disposeObject(stage.mesh);
  if (hovered === stage.mesh) setHovered(null);
  stage = null;
  destroyKeyboard();
}
const loader = new THREE.TextureLoader();
function refreshStage() {
  if (!stage || stage.loading || performance.now() - stage.at < 200) return;
  if (stage.kind === 'terminal' && termTex.has(stage.wid)) return;
  const st = stage; st.loading = true;
  loader.load(`/thumb/${st.wid}?w=${STAGE_W}&live=1&t=${Date.now()}`, (tex) => {
    if (stage !== st) { tex.dispose(); return; }
    tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const old = st.mesh.material.map;
    if (!st.aspectSet && tex.image && tex.image.width) { st.aspectSet = true; applyTexture(st.mesh, tex, tex.image.width / tex.image.height, STAGE_WIDTH_M); }
    else { st.mesh.material.map = tex; st.mesh.material.color.set(0xffffff); st.mesh.material.needsUpdate = true; }
    if (old && old !== tex) old.dispose();
    st.loading = false; st.at = performance.now();
  }, undefined, () => { st.loading = false; st.at = performance.now(); });
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
  refreshStage();
  const now = performance.now();
  for (const p of panels) {
    if (p.kind === 'terminal' && termTex.has(p.wid)) continue;
    const live = hovered && hovered.userData.wid === p.wid;
    if (now - p.at > (live ? 350 : 3000)) refresh(p, live);
  }
}, 200);

// ── pointing: XR controllers, and the mouse when flat ──────────────────────
const raycaster = new THREE.Raycaster();
const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x8ab4ff }));
  line.scale.z = 4; c.add(line);
  c.addEventListener('selectstart', () => { const hit = pickHit(c); act(hit ? hit.object : null, uvOf(hit)); });
  c.addEventListener('squeezestart', () => startResize(c));
  c.addEventListener('squeezeend', () => { resizing = null; });
  scene.add(c);
  return c;
});
const highlight = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x8ab4ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
highlight.visible = false; scene.add(highlight);
const tmpM = new THREE.Matrix4();
function pickHit(controller) {
  tmpM.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpM);
  return raycaster.intersectObjects(hoverables, false)[0] || null;
}
function pick(controller) { const h = pickHit(controller); return h ? h.object : null; }
const uvOf = (hit) => (hit && hit.uv ? { u: hit.uv.x, v: 1 - hit.uv.y } : null);   // v from the top, like the Mac
const mouse = new THREE.Vector2(-2, -2);
window.addEventListener('pointermove', (e) => { mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1); });
window.addEventListener('click', () => { if (renderer.xr.isPresenting) return; raycaster.setFromCamera(mouse, camera); const hit = raycaster.intersectObjects(hoverables, false)[0]; act(hit ? hit.object : null, uvOf(hit)); });
window.addEventListener('wheel', (e) => { if (renderer.xr.isPresenting || !stage || hovered !== stage.mesh) return; raycaster.setFromCamera(mouse, camera); const hit = raycaster.intersectObject(stage.mesh, false)[0]; const uv = uvOf(hit); if (uv) post('/input', { wid: stage.wid, type: 'scroll', ...uv, dx: e.deltaX, dy: e.deltaY }); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeStage(); });

let busy = false;
async function act(obj, uv = null) {
  if (!obj || busy) return;
  const u = obj.userData;
  if (u.action === 'stage') { if (uv && await ensureFocused()) post('/input', { wid: u.wid, type: 'click', ...uv }); return; }
  if (u.action === 'resize') return;   // resizing is a grip, not a trigger
  if (u.action === 'key') { pressKey(u); return; }
  if (u.action === 'agent') { select(u.name); report({ act: 'select', label: u.name }); return; }
  const panel = panels.find((p) => p.wid === u.wid);
  if (panel) openStage(panel, u.label);   // big here; the Mac is touched only when you click or type into it
  report({ act: 'open', label: u.label });
}
const padState = new Map();
let lastMoveAt = 0, lastScrollAt = 0;
let resizing = null;   // { controller, plane, center, startDist, startScale }
function startResize(controller) {
  const hit = pickHit(controller);
  if (!stage || !hit || hit.object.userData.action !== 'resize') return;
  const center = new THREE.Vector3(); stage.mesh.getWorldPosition(center);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(stage.mesh.getWorldQuaternion(new THREE.Quaternion()));
  resizing = { controller, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center), center, startDist: hit.point.distanceTo(center), startScale: stage.mesh.scale.x };
}
function pollGamepads() {
  const session = renderer.xr.getSession();
  if (!session) return;
  const now = performance.now();
  for (const src of session.inputSources) {
    const gp = src.gamepad; if (!gp) continue;
    const prev = padState.get(src) || {};
    const b4 = gp.buttons[4] && gp.buttons[4].pressed, b5 = gp.buttons[5] && gp.buttons[5].pressed;
    if ((b4 && !prev.b4) || (b5 && !prev.b5)) closeStage();
    padState.set(src, { b4, b5 });
    // pointing at the stage: the Mac's pointer follows; the thumbstick scrolls
    if (stage && now - lastScrollAt > 90) {
      const y = gp.axes[3] || 0;
      if (Math.abs(y) > 0.3 && stage.focused) { const c = controllers[src.handedness === 'left' ? 0 : 1]; const uv = uvOf(c && pickHit(c)); if (uv) { lastScrollAt = now; post('/input', { wid: stage.wid, type: 'scroll', ...uv, dx: 0, dy: y * 60 }); } }
    }
  }
  if (resizing) {
    const c = resizing.controller;
    tmpM.identity().extractRotation(c.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpM);
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(resizing.plane, hit)) {
      const d = hit.distanceTo(resizing.center);
      const sc = THREE.MathUtils.clamp(resizing.startScale * d / Math.max(0.05, resizing.startDist), 0.4, 3.5);
      stage.mesh.scale.setScalar(sc);
    }
  }
  if (stage && stage.focused && hovered === stage.mesh && now - lastMoveAt > 80) {
    for (const c of controllers) { const hit = pickHit(c); if (hit && hit.object === stage.mesh) { lastMoveAt = now; post('/input', { wid: stage.wid, type: 'move', ...uvOf(hit) }); break; } }
  }
}

// ── the virtual keyboard under the stage ───────────────────────────────────
// Rows of key meshes; trigger on one types it (server /input: Unicode text
// for characters, key codes for the specials). Shift/Ctrl/Cmd are sticky
// for one key. Shown only while a window is on the stage.
const KEY_ROWS = [
  [['`', '~'], ['1', '!'], ['2', '@'], ['3', '#'], ['4', '$'], ['5', '%'], ['6', '^'], ['7', '&'], ['8', '*'], ['9', '('], ['0', ')'], ['-', '_'], ['=', '+'], { key: 'backspace', label: '⌫', w: 1.6 }],
  [{ key: 'tab', label: 'Tab', w: 1.4 }, 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', ['[', '{'], [']', '}'], ['\\', '|']],
  [{ mod: 'ctrl', label: 'Ctrl', w: 1.6 }, 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', [';', ':'], ["'", '"'], { key: 'enter', label: '⏎', w: 1.8 }],
  [{ mod: 'shift', label: '⇧', w: 2.0 }, 'z', 'x', 'c', 'v', 'b', 'n', 'm', [',', '<'], ['.', '>'], ['/', '?'], { key: 'up', label: '↑' }, { key: 'escape', label: 'Esc', w: 1.2 }],
  [{ mod: 'command', label: '⌘', w: 1.6 }, { text: ' ', label: 'space', w: 7 }, { key: 'left', label: '←' }, { key: 'down', label: '↓' }, { key: 'right', label: '→' }, { text: '/', label: '/' }],
];
const KEY_W = 0.075, KEY_H = 0.07, KEY_GAP = 0.008;
let keyboard = null;   // { group, keys: [{ mesh, def }] }
const mods = { shift: false, ctrl: false, command: false };
function keyLabel(def) {
  if (typeof def === 'string') return mods.shift ? def.toUpperCase() : def;
  if (Array.isArray(def)) return mods.shift ? def[1] : def[0];
  return def.label;
}
function buildKeyboard() {
  destroyKeyboard();
  const group = new THREE.Group();
  const keys = [];
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
  group.position.set(0, EYE_Y - 0.62, -STAGE_DIST + 0.15);
  group.rotation.x = -0.55;
  scene.add(group);
}
function paintKeys() {
  if (!keyboard) return;
  for (const { mesh, def } of keyboard.keys) {
    const isMod = def && def.mod, on = isMod && mods[def.mod];
    const label = keyLabel(def);
    mesh.userData.label = label;
    const old = mesh.material.map;
    mesh.material.map = textTexture(label, { width: 192, height: 128, bg: on ? '#8ab4ff' : isMod ? '#3a3a48' : '#2a2a34', fg: on ? '#141414' : '#f0f0f0', font: `${label.length > 2 ? 40 : 56}px -apple-system, system-ui, sans-serif`, align: 'center', pad: 8 });
    mesh.material.needsUpdate = true;
    if (old) old.dispose();
  }
}
function destroyKeyboard() {
  if (!keyboard) return;
  scene.remove(keyboard.group);
  for (const { mesh } of keyboard.keys) { const i = hoverables.indexOf(mesh); if (i !== -1) hoverables.splice(i, 1); }
  disposeObject(keyboard.group);
  keyboard = null;
}
async function pressKey(u) {
  if (!stage) return;
  const def = u.def;
  if (def && def.mod) { mods[def.mod] = !mods[def.mod]; paintKeys(); return; }
  if (!(await ensureFocused())) return;
  const active = ['shift', 'ctrl', 'command'].filter((m) => mods[m]);
  const text = typeof def === 'string' ? (mods.shift ? def.toUpperCase() : def) : Array.isArray(def) ? (mods.shift ? def[1] : def[0]) : def.text;
  if (def && def.key) post('/input', { wid: stage.wid, type: 'key', key: def.key, mods: active.map((m) => (m === 'ctrl' ? 'control' : m)) });
  else if (mods.ctrl || mods.command) post('/input', { wid: stage.wid, type: 'key', key: String(text).toLowerCase(), mods: active.map((m) => (m === 'ctrl' ? 'control' : m)) });
  else post('/input', { wid: stage.wid, type: 'type', text });
  if (active.length) { mods.shift = mods.ctrl = mods.command = false; paintKeys(); }
}

function setHovered(obj) {
  hovered = obj;
  if (!obj || !obj.geometry.parameters.width) { highlight.visible = false; if (obj) obj.scale.setScalar(1.12); return; }
  const g = obj.geometry.parameters;
  highlight.scale.set(g.width + 0.03, g.height + 0.03, 1);
  obj.getWorldPosition(highlight.position); obj.getWorldQuaternion(highlight.quaternion);
  highlight.translateZ(-0.002);
  highlight.visible = true;
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  pollGamepads();
  const t = clock.getElapsedTime();
  for (const f of flowers.values()) {
    f.group.position.lerp(f.target, 0.08);
    f.group.position.y += Math.sin(t * 1.3 + f.phase) * 0.0025;
    f.sphere.scale.setScalar(THREE.MathUtils.lerp(f.sphere.scale.x, hovered === f.sphere ? 1.12 : 1, 0.2));
    f.group.lookAt(0, EYE_Y, 0);
  }
  let h = null;
  if (renderer.xr.isPresenting) { for (const c of controllers) h = pick(c) || h; }
  else { raycaster.setFromCamera(mouse, camera); const hit = raycaster.intersectObjects(hoverables, false)[0]; h = hit ? hit.object : null; }
  if (h !== hovered) setHovered(h);
  renderer.render(scene, camera);
});
renderer.xr.addEventListener('sessionstart', () => { report({ sessionStarted: true }); buildWorld(); });
renderer.xr.addEventListener('sessionend', () => { report({ sessionEnded: true }); buildWorld(); });

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
