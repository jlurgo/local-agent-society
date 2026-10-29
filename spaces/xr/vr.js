// LAS Spaces — the immersive view (WebXR + three.js). See
// docs/plans/2026-10-29-quest-spaces.md, "The workspace view".
//
// Each Space with an agent or windows is a BOARD: a header (the agent's
// name in its color, or the Space number) over a grid of PANELS, one per
// window, textured with the window's live pixels from /thumb. Boards stand
// on a RING around you in Mission Control order with the current Space
// ahead, or on a WALL (mosaic). Point a controller at a panel and pull the
// trigger to focus that window on the Mac (switching its Space); at a
// header to go to that Space. The panel you point at is refreshed live.
// Outside VR the same scene renders flat (a mouse works), which is how it
// is debugged from the Mac.
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

const hud = document.getElementById('hud');
const report = (data) => fetch('/hello', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: Date.now(), vr: true, ...data }) }).catch(() => {});
window.addEventListener('error', (e) => report({ error: String(e.message), at: `${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => report({ error: 'unhandled: ' + String(e.reason && e.reason.message || e.reason) }));
const post = (p) => fetch(p, { method: 'POST' }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));

// ── layout constants (meters) ──────────────────────────────────────────────
const PANEL_W = 0.56, PANEL_H = PANEL_W * 9 / 16, PANEL_GAP = 0.05, LABEL_H = 0.05;
const COLS = 2, BOARD_PAD = 0.06, HEADER_H = 0.11;
const EYE_Y = 1.5;
const THUMB_W = 400, LIVE_W = 1100, STAGE_W = 1500;
const STAGE_WIDTH_M = 1.7, STAGE_DIST = 1.7;

// ── renderer / scene ───────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101014);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 60);
camera.position.set(0, EYE_Y, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 1.0));
const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.MeshBasicMaterial({ color: 0x16161c }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
const grid = new THREE.GridHelper(12, 24, 0x2a2a34, 0x202028); grid.position.y = 0.001; scene.add(grid);
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
const ink = (hex) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || ''); if (!m) return '#141414'; const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45 ? '#f4f4f4' : '#141414'; };

// ── boards ─────────────────────────────────────────────────────────────────
let world = null;
let layout = localStorage.getItem('las-spaces-layout') || 'ring';
let focusedSpace = null;    // the Space whose board is big in the middle (default: the Mac's current one)
let ringOffset = 0;         // thumbstick / arrow keys turn the ring
const boards = [];          // { group, space, header, panels: [{ mesh, wid, tex, title }] }
const hoverables = [];      // meshes with userData.action
let hovered = null;

function clearBoards() {
  for (const b of boards) {
    scene.remove(b.group);
    b.group.traverse((o) => { if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } if (o.geometry) o.geometry.dispose(); });
  }
  boards.length = 0; hoverables.length = 0; hovered = null;
}

function makeBoard(space, agents) {
  const wins = [...space.windows.filter((w) => w.kind === 'terminal'), ...space.windows.filter((w) => w.kind === 'browser'), ...space.windows.filter((w) => w.kind === 'other')].slice(0, 8);
  const rows = Math.max(1, Math.ceil(wins.length / COLS));
  const w = BOARD_PAD * 2 + COLS * PANEL_W + (COLS - 1) * PANEL_GAP;
  const h = BOARD_PAD * 2 + HEADER_H + rows * (PANEL_H + LABEL_H + PANEL_GAP);
  const group = new THREE.Group();
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: space.current ? 0x1d2a44 : 0x1c1c22 }));
  group.add(back);
  const agent = agents[space.agents[0]] || null;
  const color = agent && agent.color ? agent.color : '#3a3a44';
  const headerTex = textTexture(agent ? `${agent.name}` : `Desktop ${space.index + 1}`, { width: 768, height: 96, bg: color, fg: ink(color), font: 'bold 44px -apple-system, system-ui, sans-serif', align: 'center' });
  const header = new THREE.Mesh(new THREE.PlaneGeometry(w - BOARD_PAD * 2, HEADER_H), new THREE.MeshBasicMaterial({ map: headerTex }));
  header.position.set(0, h / 2 - BOARD_PAD - HEADER_H / 2, 0.003);
  header.userData = { action: 'space', space: space.id, label: agent ? agent.name : `Desktop ${space.index + 1}` };
  group.add(header); hoverables.push(header);
  const panels = [];
  wins.forEach((win, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    const x = -w / 2 + BOARD_PAD + PANEL_W / 2 + col * (PANEL_W + PANEL_GAP);
    const y = h / 2 - BOARD_PAD - HEADER_H - PANEL_GAP - PANEL_H / 2 - row * (PANEL_H + LABEL_H + PANEL_GAP);
    const mat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), mat);
    mesh.position.set(x, y, 0.004);
    mesh.userData = { action: 'window', wid: win.wid, label: win.title || win.app };
    group.add(mesh); hoverables.push(mesh);
    const labelText = win.session ? `${win.session.agent} · ${win.session.runtime} — ${win.title}` : (win.title || win.app);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, LABEL_H), new THREE.MeshBasicMaterial({ map: textTexture(labelText, { width: 1024, height: 92, fg: win.kind === 'terminal' ? '#cfe8ff' : '#e8e8e8', font: '30px -apple-system, system-ui, sans-serif' }), transparent: true }));
    label.position.set(x, y - PANEL_H / 2 - LABEL_H / 2 - 0.005, 0.004);
    group.add(label);
    panels.push({ mesh, wid: win.wid, loading: false, at: 0 });
  });
  const b = { group, space, w, h, panels };
  boards.push(b);
  scene.add(group);
  return b;
}

function placeBoards() {
  const n = boards.length;
  if (!n) return;
  if (layout === 'wall') {
    const cols = Math.min(4, n), colW = Math.max(...boards.map((b) => b.w)) + 0.12;
    const rowsH = [];
    boards.forEach((b, i) => { const r = Math.floor(i / cols); rowsH[r] = Math.max(rowsH[r] || 0, b.h); });
    let y = EYE_Y + 0.4;
    boards.forEach((b, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      if (c === 0 && r > 0) y -= rowsH[r - 1] / 2 + rowsH[r] / 2 + 0.1;
      b.group.position.set((c - (cols - 1) / 2) * colW, y, -2.6);
      b.group.rotation.set(0, 0, 0);
      b.group.scale.setScalar(1);
    });
    return;
  }
  // ring: one big board in the middle (the focused Space — the Mac's current
  // one until you pick another), the others smaller on an arc around it, in
  // Mission Control order; the whole ring turns with the thumbstick.
  let cur = boards.findIndex((b) => b.space.id === focusedSpace);
  if (cur === -1) cur = Math.max(0, boards.findIndex((b) => b.space.current));
  const step = Math.max(...boards.map((b) => b.w)) * 0.72 + 0.14;
  const radius = Math.max(2.6, (n * step) / (2 * Math.PI) * 1.3);
  const dAngle = step / radius;
  boards.forEach((b, i) => {
    const focused = i === cur;
    const a = (i - cur) * dAngle + ringOffset;   // + to the right
    const r = focused ? 1.9 : radius;
    const sc = focused ? 1.35 : 0.72;
    b.group.position.set(Math.sin(a) * r, EYE_Y + (focused ? 0.1 : 0.25), -Math.cos(a) * r);
    b.group.scale.setScalar(sc);
    b.group.lookAt(0, b.group.position.y, 0);
    b.group.children[0].material.color.set(focused ? 0x1d2a44 : b.space.current ? 0x22304a : 0x1c1c22);
  });
}

function buildWorld() {
  clearBoards();
  if (!world || !world.displays[0]) return;
  const agents = Object.fromEntries(world.agents.map((a) => [a.name, a]));
  for (const s of world.displays[0].spaces) if (s.agents.length || s.windows.length) makeBoard(s, agents);
  if (!focusedSpace || !boards.some((b) => b.space.id === focusedSpace)) { const c = world.displays[0].spaces.find((s) => s.current); focusedSpace = c ? c.id : null; }
  placeBoards();
  if (stage && !boards.some((b) => b.panels.some((p) => p.wid === stage.wid))) closeStage();
  hud.textContent = `LAS Spaces — ${boards.length} boards · ${layout} · ${renderer.xr.isPresenting ? 'in VR' : 'flat (press Enter VR)'} · trigger: open · grip: layout · stick: turn · B/Y: close`;
}

// ── the stage: one window, big and live, in front of you ────────────────────
// Trigger on a panel: the Mac focuses that window (your keyboard goes there)
// and it opens here at STAGE_W px, refreshed as fast as the server captures.
// Trigger on the stage, or B/Y, closes it. Pointer input INTO it is a later
// phase (plan: phase 6).
let stage = null;
function openStage(panel, label) {
  closeStage();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(STAGE_WIDTH_M, STAGE_WIDTH_M * 9 / 16), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  mesh.position.set(0, EYE_Y + 0.05, -STAGE_DIST);
  mesh.userData = { action: 'stage', wid: panel.wid, label };
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(STAGE_WIDTH_M + 0.04, STAGE_WIDTH_M * 9 / 16 + 0.04), new THREE.MeshBasicMaterial({ color: 0x8ab4ff }));
  frame.position.z = -0.003;
  mesh.add(frame);
  const title = new THREE.Mesh(new THREE.PlaneGeometry(STAGE_WIDTH_M, 0.07), new THREE.MeshBasicMaterial({ map: textTexture(label, { width: 1536, height: 64, font: '34px -apple-system, system-ui, sans-serif', fg: '#fff' }), transparent: true }));
  title.position.y = STAGE_WIDTH_M * 9 / 32 + 0.05;
  mesh.add(title);
  scene.add(mesh); hoverables.push(mesh);
  stage = { wid: panel.wid, mesh, loading: false, at: 0, aspectSet: false };
}
function closeStage() {
  if (!stage) return;
  scene.remove(stage.mesh);
  const i = hoverables.indexOf(stage.mesh); if (i !== -1) hoverables.splice(i, 1);
  stage.mesh.traverse((o) => { if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } if (o.geometry) o.geometry.dispose(); });
  if (hovered === stage.mesh) setHovered(null);
  stage = null;
}
function refreshStage() {
  if (!stage || stage.loading || performance.now() - stage.at < 200) return;
  const st = stage; st.loading = true;
  loader.load(`/thumb/${st.wid}?w=${STAGE_W}&live=1&t=${Date.now()}`, (tex) => {
    if (stage !== st) { tex.dispose(); return; }
    tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const old = st.mesh.material.map;
    st.mesh.material.map = tex; st.mesh.material.color.set(0xffffff); st.mesh.material.needsUpdate = true;
    if (old) old.dispose();
    if (!st.aspectSet && tex.image && tex.image.width) {   // the real window's aspect, once
      st.aspectSet = true;
      const h = STAGE_WIDTH_M * tex.image.height / tex.image.width;
      st.mesh.geometry.dispose(); st.mesh.geometry = new THREE.PlaneGeometry(STAGE_WIDTH_M, h);
      st.mesh.children[0].geometry.dispose(); st.mesh.children[0].geometry = new THREE.PlaneGeometry(STAGE_WIDTH_M + 0.04, h + 0.04);
      st.mesh.children[1].position.y = h / 2 + 0.05;
    }
    st.loading = false; st.at = performance.now();
  }, undefined, () => { st.loading = false; st.at = performance.now(); });
}

// ── textures: every panel every ~3 s, the pointed one live ─────────────────
const loader = new THREE.TextureLoader();
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
// Refresh budget (the Mac pays for every capture): the pointed panel and the
// stage live; the focused board's panels every 3 s; every other board's
// every 12 s, and only while its panels can be seen.
setInterval(() => {
  refreshStage();
  const now = performance.now();
  for (const b of boards) {
    const focused = b.space.id === focusedSpace;
    for (const p of b.panels) {
      const live = hovered && hovered.userData.wid === p.wid;
      const every = live ? 350 : focused ? 3000 : 12000;
      if (now - p.at > every) refresh(p, live);
    }
  }
}, 200);

// ── pointing: XR controllers, and the mouse when flat ──────────────────────
const raycaster = new THREE.Raycaster();
const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x8ab4ff }));
  line.scale.z = 4; c.add(line);
  c.addEventListener('selectstart', () => act(pick(c)));
  c.addEventListener('squeezestart', () => toggleLayout());
  scene.add(c);
  return c;
});
const highlight = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x8ab4ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
highlight.visible = false; scene.add(highlight);
const tmpM = new THREE.Matrix4();
function pick(controller) {
  tmpM.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpM);
  const hit = raycaster.intersectObjects(hoverables, false)[0];
  return hit ? hit.object : null;
}
const mouse = new THREE.Vector2(-2, -2);
window.addEventListener('pointermove', (e) => { mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1); });
window.addEventListener('click', (e) => { if (renderer.xr.isPresenting) return; raycaster.setFromCamera(mouse, camera); const hit = raycaster.intersectObjects(hoverables, false)[0]; act(hit ? hit.object : null); });
window.addEventListener('keydown', (e) => { if (e.key === 'l') toggleLayout(); });
function toggleLayout() { layout = layout === 'ring' ? 'wall' : 'ring'; localStorage.setItem('las-spaces-layout', layout); placeBoards(); hud.textContent = hud.textContent.replace(/ring|wall/, layout); }

let busy = false;
async function act(obj) {
  if (!obj || busy) return;
  const u = obj.userData;
  if (u.action === 'stage') { closeStage(); return; }
  busy = true;
  let r;
  if (u.action === 'window') {
    const panel = boards.flatMap((b) => b.panels).find((p) => p.wid === u.wid);
    if (panel) openStage(panel, u.label);
    r = await post(`/window/${u.wid}/focus`);
  } else {
    focusedSpace = u.space; ringOffset = 0; placeBoards();
    r = await post(`/space/${u.space}/activate`);
  }
  report({ act: u.action, label: u.label, result: r });
  busy = false;
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { ringOffset += 0.12; placeBoards(); }
  if (e.key === 'ArrowRight') { ringOffset -= 0.12; placeBoards(); }
  if (e.key === 'Escape') closeStage();
});
// Thumbstick turns the ring; B/Y closes the stage; A/X toggles the layout.
const padState = new Map();
let lastTick = performance.now();
function pollGamepads() {
  const now = performance.now(), dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
  const session = renderer.xr.getSession();
  if (!session) return;
  for (const src of session.inputSources) {
    const gp = src.gamepad; if (!gp) continue;
    const x = gp.axes[2] || 0;
    if (Math.abs(x) > 0.25) { ringOffset -= x * dt * 1.6; placeBoards(); }
    const prev = padState.get(src) || {};
    const b4 = gp.buttons[4] && gp.buttons[4].pressed, b5 = gp.buttons[5] && gp.buttons[5].pressed;
    if (b4 && !prev.b4) toggleLayout();
    if (b5 && !prev.b5) closeStage();
    padState.set(src, { b4, b5 });
  }
}

function setHovered(obj) {
  hovered = obj;
  if (!obj) { highlight.visible = false; return; }
  const g = obj.geometry.parameters;
  highlight.scale.set(g.width + 0.03, g.height + 0.03, 1);
  obj.getWorldPosition(highlight.position); obj.getWorldQuaternion(highlight.quaternion);
  highlight.translateZ(-0.002);
  highlight.visible = true;
}

renderer.setAnimationLoop(() => {
  pollGamepads();
  let h = null;
  if (renderer.xr.isPresenting) { for (const c of controllers) { h = pick(c) || h; } }
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
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.type === 'world') { world = d.world; buildWorld(); } };
  ws.onclose = () => setTimeout(connect, 2000);
}
connect();
report({ loaded: true, secure: window.isSecureContext, xr: Boolean(navigator.xr) });
