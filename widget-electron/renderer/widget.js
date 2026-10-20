'use strict';

/**
 * Renderer logic for one agent widget window. No Node/Electron APIs here —
 * everything comes through the `window.las` bridge exposed by preload.js.
 */

const agentName = window.las.getAgentName() || 'Agent';

// Paint the real widget color on the very first frame instead of a flash
// of widget.css's placeholder green: main.js already knows this window's
// saved color/opacity synchronously (electron-store) before it even calls
// loadFile, so it passes them in the URL query string alongside `agent` —
// applyColorVars (defined below) is called with them immediately, ahead of
// the async window.las.getPrefs() round-trip in init() that used to be the
// only thing setting these CSS vars.
{
  const initialParams = new URLSearchParams(window.location.search);
  const initialColor = initialParams.get('color');
  const initialOpacity = initialParams.get('opacity');
  if (initialColor && initialOpacity !== null) {
    applyColorVars(initialColor, Number(initialOpacity));
  }
}

const nameEl = document.getElementById('name');
const logEl = document.getElementById('log');
const widgetEl = document.getElementById('widget');
const gearEl = document.getElementById('gear');
const settingsEl = document.getElementById('settings');
const colorEl = document.getElementById('color');
const opacityEl = document.getElementById('opacity');
const alwaysOnTopEl = document.getElementById('alwaysOnTop');
const muteEl = document.getElementById('mute');
const expandWhenHiddenEl = document.getElementById('expandWhenHidden');
const wakeEnabledEl = document.getElementById('wakeEnabled');
const micLanguageEl = document.getElementById('micLanguage');
const micTargetEl = document.getElementById('micTarget');
const ccDefaultEl = document.getElementById('ccDefault');
const doorEl = document.getElementById('door');

document.title = agentName;

// ── name sizing/line-breaking ────────────────────────────────────────────────
// Ported from the retired Swift widget's fitFontSizeAndSplit/smartSplit
// (swift-widget-final tag, widget/tray.swift): shrink the name from a
// starting size until it fits on one line, and if it still doesn't at a
// reasonable size, break it at whichever generic title boundary — a space,
// a hyphen, or a lowercase->Uppercase (camelCase/PascalCase) transition —
// falls closest to the middle, then fit that two-line version instead.
// Applied both to the compact face (name must fully fit the default widget
// width) and the occlusion-expanded banner (name should fill the much
// bigger box), just with different size/box bounds — see fitNameToBox.

const measureCtx = document.createElement('canvas').getContext('2d');

function measureTextWidth(text, sizePx) {
  measureCtx.font = `800 ${sizePx}px -apple-system, "Segoe UI", system-ui, sans-serif`;
  return measureCtx.measureText(text).width;
}

function smartSplit(text) {
  const chars = [...text];
  const mid = chars.length / 2;

  let bestSpaceIdx = -1;
  let bestSpaceDist = Infinity;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === ' ' || chars[i] === '-') {
      const dist = Math.abs(i - mid);
      if (dist < bestSpaceDist) { bestSpaceDist = dist; bestSpaceIdx = i; }
    }
  }
  if (bestSpaceIdx !== -1) {
    const before = chars.slice(0, bestSpaceIdx).join('').trim();
    const after = chars.slice(bestSpaceIdx + 1).join('').trim();
    if (before && after) return `${before}\n${after}`;
  }

  let bestCamelIdx = -1;
  let bestCamelDist = Infinity;
  for (let i = 1; i < chars.length; i++) {
    if (/[A-Z]/.test(chars[i]) && /[a-z]/.test(chars[i - 1])) {
      const dist = Math.abs(i - mid);
      if (dist < bestCamelDist) { bestCamelDist = dist; bestCamelIdx = i; }
    }
  }
  if (bestCamelIdx !== -1) return `${chars.slice(0, bestCamelIdx).join('')}\n${chars.slice(bestCamelIdx).join('')}`;

  return text;
}

function fitFontSizeAndSplit(text, maxWidth, maxHeight, start, min) {
  const effectiveStart = maxHeight ? Math.min(start, Math.floor(maxHeight * 0.9)) : start;

  let size = effectiveStart;
  const singleLineFloor = Math.max(min, Math.floor(effectiveStart * 0.5));
  while (size > singleLineFloor) {
    if (measureTextWidth(text, size) <= maxWidth) return { size, text };
    size -= 1;
  }

  const splitText = smartSplit(text);
  if (splitText !== text) {
    const lines = splitText.split('\n');
    const availH = maxHeight || 96;
    let splitSize = Math.min(effectiveStart, Math.floor(availH / 2.2));
    while (splitSize > min) {
      const maxW = Math.max(...lines.map((l) => measureTextWidth(l, splitSize)));
      if (maxW <= maxWidth) return { size: splitSize, text: splitText };
      splitSize -= 1;
    }
    return { size: min, text: splitText };
  }

  while (size > min) {
    if (measureTextWidth(text, size) <= maxWidth) return { size, text };
    size -= 1;
  }
  return { size: min, text };
}

const COMPACT_START_SIZE = 32;
const COMPACT_MIN_SIZE = 13;
const EXPANDED_MIN_SIZE = 40;

function fitNameToBox() {
  const expanded = widgetEl.classList.contains('occlusion-expanded');
  let maxWidth;
  let maxHeight = null;
  let start;
  let min;
  if (expanded) {
    maxWidth = window.innerWidth * 0.92;
    maxHeight = window.innerHeight * 0.8;
    start = Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.35);
    min = EXPANDED_MIN_SIZE;
  } else {
    const doorWidth = doorEl.offsetWidth || 26;
    maxWidth = Math.max(40, nameEl.parentElement.clientWidth - doorWidth - 8);
    start = COMPACT_START_SIZE;
    min = COMPACT_MIN_SIZE;
  }
  const { size, text } = fitFontSizeAndSplit(agentName, maxWidth, maxHeight, start, min);
  nameEl.style.fontSize = `${size}px`;
  const isSplit = text.includes('\n');
  nameEl.style.whiteSpace = isSplit ? 'pre-line' : 'nowrap';
  nameEl.style.lineHeight = isSplit ? '1.05' : '';
  nameEl.textContent = text;
  // Occlusion-expanded's banner name is always centered via its own CSS
  // (position untouched by --reveal, see widget.css's .occlusion-expanded
  // .name override) — no need to compute a hover-reveal target for it.
  if (!expanded) updateNameCenterOffset(size, text);
}

fitNameToBox();

// Where the hover-resting name should land: the distance from #name's
// normal (fully revealed) position to the widget's geometric center, plus
// the local x-coordinate the "grow" scale should expand from. Measured off
// the ACTUAL rendered text (via the same canvas metrics fitFontSizeAndSplit
// uses), not #name's flex-stretched box width — the box fills the space
// between the widget's left edge and the door button regardless of how
// short the name is, so centering on the box instead of the glyphs would
// leave the resting title visibly off-center. offsetLeft/offsetTop/
// offsetHeight are layout-only (unaffected by the CSS transform this very
// function feeds), so this stays correct however far along --reveal is.
function updateNameCenterOffset(size, text) {
  const lines = text.split('\n');
  const textWidth = Math.max(...lines.map((l) => measureTextWidth(l, size)));
  const cx = widgetEl.clientWidth / 2 - (nameEl.offsetLeft + textWidth / 2);
  const cy = widgetEl.clientHeight / 2 - (nameEl.offsetTop + nameEl.offsetHeight / 2);
  widgetEl.style.setProperty('--name-cx', `${cx}px`);
  widgetEl.style.setProperty('--name-cy', `${cy}px`);
  widgetEl.style.setProperty('--name-origin-x', `${textWidth / 2}px`);
}

// micLanguage defaults to Spanish, not auto-detect or the agent's TTS
// locale — per explicit request: dictation should assume Spanish unless the
// user picks otherwise, since it's what most agents on this machine are
// dictated to in regardless of what language their own TTS voice speaks.
let prefs = { color: '#90c060', opacity: 0.72, alwaysOnTop: true, mute: false, expandWhenHidden: true, micLanguage: 'es' };
let locale = 'en-US';
// Optional Kokoro voice id pinned in this agent's .las-agent.json (`tts_voice`,
// e.g. "em_alex"). When set and known to the pool it beats the name hash in
// speak() — the only way to choose a voice's gender explicitly, since the
// hash only guarantees a voice in the agent's language.
let ttsVoice = null;

/** '#rrggbb' + 0..1 alpha -> 'rgba(r, g, b, a)'. */
function hexToRgba(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** '#rrggbb' + 0..1 alpha, darkened by `amount` (0..1) -> 'rgba(r, g, b, a)'.
 * Used for the local-msg accent tail: a hue tied to the widget's own color
 * (unlike the neutral --bubble-tint), but a shade darker so it reads as an
 * accent on top of the same-hued bubble rather than disappearing into it. */
function darkenHexToRgba(hex, alpha, amount) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.round(((n >> 16) & 255) * (1 - amount));
  const g = Math.round(((n >> 8) & 255) * (1 - amount));
  const b = Math.round((n & 255) * (1 - amount));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * WCAG relative luminance of a '#rrggbb' color, 0 (black) .. 1 (white).
 * Used to pick dark-on-light vs light-on-dark log/bubble text instead of a
 * fixed color — the widget's background is user-configurable (any hue,
 * light or dark), so a hardcoded text color reads fine against some choices
 * and unreadable against others.
 */
function relativeLuminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const toLinear = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = toLinear((n >> 16) & 255);
  const g = toLinear((n >> 8) & 255);
  const b = toLinear(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Sets just the color-derived CSS custom properties on :root — the subset
 * that determines the widget's visible background/text/bubble tint. Split
 * out from applyPrefsToDom so it can also run synchronously at script
 * start (see the top of this file), from color/opacity handed in via the
 * URL query string, before the async window.las.getPrefs() round-trip
 * resolves — otherwise the window briefly paints widget.css's fallback
 * --widget-bg (a placeholder green) and only switches to the real color
 * once that IPC call returns, which reads as a startup flash/glitch.
 *
 * Set on the root, not widgetEl: #settings/#openMenu/#childrenMenu are
 * not all descendants of #widget's own inline style scope, so a CSS custom
 * property set on widgetEl wouldn't reliably inherit into them — :root is
 * the shared ancestor all of them do inherit from.
 */
function applyColorVars(color, opacity) {
  // --widget-bg bakes the opacity into the background color's alpha channel
  // instead of the old `opacity` CSS property on .widget: that property faded
  // EVERYTHING including text/buttons, which is why a very transparent widget
  // used to make the agent name unreadable too. Now only fills fade with the
  // opacity slider — the crisp outline (text-stroke on the name, border on
  // the face buttons) stays fully opaque regardless, so both stay legible.
  document.documentElement.style.setProperty('--widget-bg', hexToRgba(color, opacity));
  document.documentElement.style.setProperty('--text-fill', hexToRgba('#141414', opacity));
  document.documentElement.style.setProperty('--btn-fill', `rgba(0, 0, 0, ${(0.16 * opacity).toFixed(3)})`);

  // Log/bubble contrast: dark widget color -> light text on a light-tinted
  // bubble, light widget color -> dark text on a dark-tinted bubble — same
  // two degrees of freedom as the rest of the widget (the chosen color and
  // opacity), no fixed opaque plate that would defeat the transparency the
  // opacity slider is there to control. The tint alpha is NOT multiplied by
  // opacity — like the button/name outlines, bubbles need a legibility
  // floor that survives even a very transparent widget.
  const isDarkBg = relativeLuminance(color) < 0.5;
  document.documentElement.style.setProperty('--log-text', isDarkBg ? 'rgba(245, 245, 245, 0.95)' : 'rgba(20, 20, 20, 0.92)');
  document.documentElement.style.setProperty('--bubble-tint', isDarkBg ? 'rgba(255, 255, 255, 0.14)' : 'rgba(0, 0, 0, 0.06)');
  document.documentElement.style.setProperty('--bubble-border', isDarkBg ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.25)');

  // Local-msg accent tail: tied to the widget's OWN color (not the neutral
  // black/white --bubble-tint), a shade darker so the little top-center peak
  // reads as "this came from the title above" rather than blending in.
  document.documentElement.style.setProperty('--local-accent', darkenHexToRgba(color, 0.9, 0.25));
}

function applyPrefsToDom() {
  applyColorVars(prefs.color, prefs.opacity);

  colorEl.value = prefs.color;
  opacityEl.value = String(prefs.opacity);
  alwaysOnTopEl.checked = !!prefs.alwaysOnTop;
  muteEl.checked = !!prefs.mute;
  expandWhenHiddenEl.checked = !!prefs.expandWhenHidden;
  micLanguageEl.value = prefs.micLanguage || 'es';
  syncMicTargetSelect();
  updateSpeakerIcon();
}

async function init() {
  prefs = await window.las.getPrefs(agentName);
  applyPrefsToDom();
  reportVisibility();   // tells main whether this agent may grow (expandWhenHidden)
  // The mic's target is the agent's own choice (its .las-agent.json), not a
  // window pref — see the children button section.
  refreshSessions().then(syncMicTargetSelect);
  try {
    const info = await window.las.getAgentInfo(agentName);
    if (info && info.locale) locale = info.locale;
    if (info && info.ttsVoice) ttsVoice = info.ttsVoice;
  } catch (err) {
    console.warn('[widget] could not resolve agent locale, defaulting to en-US:', err);
  }
  try {
    const { wake_enabled } = await window.las.getWakeEnabled(agentName);
    wakeEnabledEl.checked = !!wake_enabled;
  } catch (err) {
    console.warn('[widget] could not resolve wake-enabled state:', err);
  }
}
init();

// ── settings panel ──────────────────────────────────────────────────────────

// Settings is inline now (see index.html), not a full-screen overlay — the
// real name/log stay visible above it, and only the bottom-row face buttons
// (besides gear itself) hide while it's open. Gear toggles it open/closed
// and shows .active ("pressed") while open, both as the visual indicator
// and as the only way back besides re-clicking it.
// ── drawers: ONE inline panel below the button bar, window grows down ─────
//
// Settings, the Open menu and the children menu are all the same thing to
// the layout: a drawer in normal flow under the buttons (never a popover
// floating over the log — unreadable on a translucent face — never a
// full-window overlay). Exactly one is open at a time. Opening one measures
// its natural height and asks main.js to make the window taller by that
// much (same x/y/width); closing it restores the compact size. Re-render a
// drawer while open (rows loaded, a row moved) and call fitWindowToDrawer()
// again — main.js re-fits an already-expanded window.

const DRAWER_GAP_PX = 8;
const drawerElements = {};
let activeDrawer = null; // 'settings' | 'open' | 'children' | null
let compactHeight = null; // window height before any drawer opened

function registerDrawer(name, el, onClose) {
  drawerElements[name] = { el, onClose };
}

function openDrawer(name) {
  const { el } = drawerElements[name];
  if (activeDrawer && activeDrawer !== name) {
    const previous = drawerElements[activeDrawer];
    previous.el.classList.add('hidden');
    if (previous.onClose) previous.onClose();
  }
  if (activeDrawer === null) compactHeight = window.innerHeight;
  activeDrawer = name;
  el.classList.remove('hidden');
  // Any open drawer locks the face fully revealed (see revealLocked): the
  // title stays put and the icons stay visible until the drawer closes.
  // Latch "revealed" too, so closing it doesn't hand control back to
  // mousemove mid-entrance.
  cancelPendingLeave();
  revealed = true;
  setReveal(1, { settle: true });
  fitWindowToDrawer();
}

/** Grow the window to the compact height plus the open drawer's height. */
function fitWindowToDrawer() {
  if (!activeDrawer) return;
  const { el } = drawerElements[activeDrawer];
  requestAnimationFrame(() => {
    if (activeDrawer === null) return;
    window.las.setExpanded(true, compactHeight + el.offsetHeight + DRAWER_GAP_PX);
  });
}

function closeDrawer(name) {
  if (activeDrawer !== name) return;
  drawerElements[name].el.classList.add('hidden');
  activeDrawer = null;
  compactHeight = null;
  window.las.setExpanded(false);
}

let settingsOpen = false;
registerDrawer('settings', settingsEl, () => setSettingsOpen(false, true));

/** `fromDrawer`: the drawer controller already hid the panel (another drawer replaced it) — only the mode/gear state needs updating. */
function setSettingsOpen(open, fromDrawer = false) {
  settingsOpen = open;
  widgetEl.classList.toggle('settings-open', open);
  gearEl.classList.toggle('active', open);
  if (!fromDrawer) {
    if (open) openDrawer('settings');
    else closeDrawer('settings');
  }
  if (open) {
    refreshSessions().then(() => {
      syncMicTargetSelect();
      fitWindowToDrawer();
    });
  }
}

gearEl.addEventListener('click', () => setSettingsOpen(!settingsOpen));

async function persist(patch) {
  prefs = await window.las.setPrefs(agentName, patch);
  applyPrefsToDom();
  if (prefs.mute) stopCurrentSpeech();
}

colorEl.addEventListener('input', () => persist({ color: colorEl.value }));
opacityEl.addEventListener('input', () => persist({ opacity: Number(opacityEl.value) }));
alwaysOnTopEl.addEventListener('change', () => persist({ alwaysOnTop: alwaysOnTopEl.checked }));
muteEl.addEventListener('change', () => persist({ mute: muteEl.checked }));
expandWhenHiddenEl.addEventListener('change', () => {
  persist({ expandWhenHidden: expandWhenHiddenEl.checked });
  reportVisibility();
});
micLanguageEl.addEventListener('change', () => persist({ micLanguage: micLanguageEl.value }));
micTargetEl.addEventListener('change', () => setSessionsConfig({ target: micTargetEl.value }));
ccDefaultEl.addEventListener('change', () => setSessionsConfig({ cc_default: ccDefaultEl.checked }));

// Backend-synced, not electron-store: `las agent focus`'s wake fallback
// (Python, backend/main.py) reads the same flag this checkbox sets.
wakeEnabledEl.addEventListener('change', () => {
  window.las.setWakeEnabled(agentName, wakeEnabledEl.checked);
});

// Door button: mark inactive + close this widget. See main.js's
// agent:deactivate comment — never touches the Claude Code session itself.
doorEl.addEventListener('click', async () => {
  try {
    await window.las.deactivateAgent(agentName);
  } catch (err) {
    console.warn('[widget] deactivate: request failed:', err);
  }
});

// ── expand when hidden (retired Swift "Expand on space change") ────────────
//
// document.visibilitychange on macOS tracks real window occlusion (covered
// by another window, or moved off the active Space) — see main.js's
// window:set-occlusion-expanded comment for why this is the closest
// Electron-only equivalent of the retired NSWindowOcclusionState-based
// mechanism, and why the expanded state is click-through (can never block
// typing into whatever is actually on screen).
//
// Debounced: a brief flicker (e.g. a menu momentarily covering the widget)
// shouldn't trigger a full expand/collapse cycle.

let occlusionExpanded = false;
let visibilityDebounce = null;

// How long to wait, after the widget becomes visible again, before shrinking
// back down to the compact face — separate from the (short, fixed) debounce
// on the way INTO occlusion below. Easy to tune: just this one constant.
const RESTORE_DELAY_MS = 1000;

// Main decides whether this widget is grown (main.js "tile reconciler": by
// macOS Space, not by occlusion) — the renderer only reports its visibility,
// the fallback signal when the Space can't be read, and applies the face.
function reportVisibility() {
  window.las.reportVisibility(document.visibilityState === 'hidden', !!prefs.expandWhenHidden);
}

window.las.onOcclusionState((expanded) => {
  if (expanded === occlusionExpanded) return;
  occlusionExpanded = expanded;
  widgetEl.classList.toggle('occlusion-expanded', expanded);
  fitNameToBox();
});

document.addEventListener('visibilitychange', () => {
  if (visibilityDebounce) clearTimeout(visibilityDebounce);
  const hidden = document.visibilityState === 'hidden';
  // Going hidden: short debounce, just enough to skip brief flickers (e.g. a
  // menu momentarily covering the widget). Coming back visible: the longer,
  // configurable RESTORE_DELAY_MS — don't yank the banner away the instant
  // you glance back at the Space.
  visibilityDebounce = setTimeout(() => {
    if (!prefs.expandWhenHidden) return;
    reportVisibility();
  }, hidden ? 400 : RESTORE_DELAY_MS);
});

// System sleep/wake: no NEW occlusion notification fires on wake if the
// window's occlusion state is unchanged from before sleep (see main.js's
// powerMonitor 'resume' comment), so a widget that was off-Space going into
// sleep can wake up stuck compact instead of expanded/mosaic. Re-read the
// actual visibilityState immediately (no debounce) rather than waiting on an
// event that may never re-fire.
window.las.onSystemResume(() => {
  if (visibilityDebounce) clearTimeout(visibilityDebounce);
  reportVisibility();
});

window.addEventListener('resize', () => fitNameToBox());

// ── hover reveal: cursor-depth-driven face ──────────────────────────────────
//
// Resting face: #name sits centered and scaled up (see widget.css's .name
// transform), door/log/buttonbar invisible. As the cursor crosses in from
// whichever edge of the widget is nearest, --reveal tracks how far it has
// traveled — 0 right at the border, 1 once it has advanced inward by the
// same distance the face buttons already sit inset from that border (the
// widget's own CSS padding, read live rather than hardcoded so this stays
// correct if that padding ever changes). Tracking uses REVEAL_TRACK_MS, a
// small capped duration, rather than 0s: a mouse that crosses the whole
// margin in one fast swipe would otherwise SNAP straight to fully revealed
// with nothing to see — capping the speed means even a fast entrance still
// takes this little bit of time, so the title's slide-and-shrink is always
// visible (the "ilusión de materialidad" this is going for), while staying
// short enough to still read as immediate. A longer, separate duration
// (REVEAL_SETTLE_MS) is only used for the moments where --reveal jumps
// WITHOUT the mouse still driving it: leaving the widget, or a locked state
// (settings open, occlusion-expanded banner) forcing a value.
const REVEAL_TRACK_MS = 70;
const REVEAL_SETTLE_MS = 380;
const REVEAL_INTERACTIVE_THRESHOLD = 0.6;

function revealMarginPx() {
  const cs = getComputedStyle(widgetEl);
  const h = parseFloat(cs.paddingLeft) || 16;
  const v = parseFloat(cs.paddingTop) || 14;
  // The tighter of the two axes — icons are inset by whichever margin is
  // smaller, so that's the depth that should mean "fully revealed".
  return Math.max(4, Math.min(h, v));
}

function setReveal(value, { settle } = {}) {
  const v = Math.max(0, Math.min(1, value));
  widgetEl.style.setProperty('--reveal-speed', `${settle ? REVEAL_SETTLE_MS : REVEAL_TRACK_MS}ms`);
  widgetEl.style.setProperty('--reveal', String(v));
  widgetEl.classList.toggle('reveal-interactive', v >= REVEAL_INTERACTIVE_THRESHOLD);
}

setReveal(0);

// Any open drawer (settings, Open menu, children menu — an active
// interaction) and the full-screen occlusion banner (its own always-visible
// centered name, see .occlusion-expanded overrides in widget.css) opt out of
// mouse-depth-driven reveal entirely: leaving the widget with a drawer open
// neither centers the title nor hides the icons. Close the drawer and the
// automatic reveal is back.
function revealLocked() {
  return activeDrawer !== null || widgetEl.classList.contains('occlusion-expanded');
}

// Two states, not a value that's recomputed on every mousemove forever:
//
//   - Entering: depth/margin drives --reveal from 0 toward 1, 1:1 with the
//     cursor (no transition) — this is the only part that "follows" the
//     mouse, purely as the entrance gets pushed in from the border.
//   - Revealed (latched once depth crosses the margin): --reveal just STAYS
//     at 1. Mousemove is ignored entirely for reveal purposes from then on —
//     wandering anywhere inside the widget (including right back over the
//     now-visible icons, which necessarily sit at shallow depth) can't
//     recompute anything and yank it back down. This is what fixes the
//     earlier "va para atrás y para adelante" flicker: that came from
//     treating depth as a live value for as long as the cursor stayed
//     inside, instead of a one-shot entrance trigger.
//
// Only mouseleave (debounced below) drops back to Entering/resting.
let revealed = false;

function trackEntrance(depthRatio) {
  if (revealed) return;
  if (depthRatio >= 1) {
    revealed = true;
    setReveal(1, { settle: false });
    return;
  }
  setReveal(depthRatio, { settle: false });
}

// A native mouseleave fires the instant the cursor crosses the widget's
// exact pixel boundary — a window this small means just grazing the edge
// while moving toward something else (or a hair of pointer jitter) reads as
// "left" and yanks the face back to resting mid-interaction. Rather than
// collapsing immediately, arm a short timer instead: only if the cursor is
// STILL outside once it fires (no mousemove/mouseenter cancelled it first)
// do we treat the widget as definitively left. That's the "debounce en
// tiempo" — the nearest thing to a spatial buffer an Electron window this
// size can give us without literally growing the window past the visible
// rounded rect (mouse events simply stop arriving once the cursor is past
// the real window edge, so there's no space to measure "how far outside").
const REVEAL_LEAVE_DEBOUNCE_MS = 260;
let leaveTimer = null;

function cancelPendingLeave() {
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
}

widgetEl.addEventListener('mousemove', (e) => {
  if (resizing || revealLocked()) return;
  cancelPendingLeave();
  if (revealed) return;
  const rect = widgetEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const depth = Math.min(x, rect.width - x, y, rect.height - y);
  trackEntrance(depth / revealMarginPx());
});

widgetEl.addEventListener('mouseenter', () => {
  cancelPendingLeave();
});

widgetEl.addEventListener('mouseleave', () => {
  // Dragging the manual resize handle (see "manual resize" section below)
  // moves the window itself via IPC, which lags the cursor just enough that
  // widgetEl's live getBoundingClientRect() often reads the pointer as
  // outside mid-drag — a real mouseleave that has nothing to do with the
  // user actually leaving. Ignore it entirely while resizing; the drag's
  // own mouseup/mousemove handlers don't touch reveal state at all, so
  // there's nothing here that needs to run once resizing stops either.
  if (revealLocked() || resizing) return;
  cancelPendingLeave();
  leaveTimer = setTimeout(() => {
    leaveTimer = null;
    revealed = false;
    // The only spot that animates with a real transition instead of
    // tracking the cursor 1:1 — settling smoothly back into the centered,
    // scaled-up title card.
    setReveal(0, { settle: true });
  }, REVEAL_LEAVE_DEBOUNCE_MS);
});

// ── message log ─────────────────────────────────────────────────────────────

// Cache of other agents' widget colors (for the external-msg name chip) —
// keyed by agent name, populated lazily via window.las.getPrefs(fromName).
// Same electron-store all widgets share (see main.js's getPrefs), so this is
// just avoiding a repeat IPC round-trip per message from the same sender.
const agentColorCache = new Map();
async function getAgentColor(name) {
  if (agentColorCache.has(name)) return agentColorCache.get(name);
  const p = await window.las.getPrefs(name).catch(() => null);
  const color = (p && p.color) || '#90c060';
  agentColorCache.set(name, color);
  return color;
}

// Three distinct, non-overlapping bubble kinds — none of them merge into
// another (per explicit request: mic dictation must never read as this
// agent's own voice, and an external agent's message must never read as
// either): mic dictation (right, "user-msg", "mic" description), this
// agent's own voice/local widget (small margins both sides, "local-msg", no
// name — a centered accent tail says "the title itself is speaking"
// instead), and messages received from OTHER agents (left, "external-msg",
// always showing the sender's name as a color-chip pill, tinted with THAT
// agent's own widget color — the same color you'd see on their widget).
function appendLogEntry(envelope, { speak } = {}) {
  const row = document.createElement('div');
  // A dictated message is a self-send: {from: agentName, to: agentName,
  // source: 'human'} — see main.js's vortexia:send handler. That's the
  // person dictating TO the agent's inbox, not the agent talking to itself,
  // so it renders as a chat bubble on the right (the "user"/mic side).
  const isOwnDictation = envelope.source === 'human' && envelope.from === agentName && envelope.to === agentName;
  // This agent's own voice output (TTS speak events off the queue) arrives
  // as {from: "queue", to: agentName, kind: "speak"} — see backend/main.py's
  // tts_drainer, which hardcodes from:"queue" rather than the agent's own
  // name. Detect it by kind/the `speak` flag, not by `from`.
  const isOwnVoice = !isOwnDictation && (speak || envelope.kind === 'speak');

  if (isOwnDictation) {
    row.className = 'entry user-msg';
    const bubble = document.createElement('span');
    bubble.className = 'bubble';
    bubble.textContent = envelope.text || '';
    row.appendChild(bubble);
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = 'mic';
    row.appendChild(desc);
  } else if (isOwnVoice) {
    row.className = 'entry local-msg' + (speak ? ' speak' : '');
    const bubble = document.createElement('span');
    bubble.className = 'bubble';
    bubble.textContent = envelope.text || '';
    row.appendChild(bubble);
  } else {
    row.className = 'entry external-msg' + (speak ? ' speak' : '');
    const bubble = document.createElement('span');
    bubble.className = 'bubble';
    bubble.textContent = envelope.text || '';
    row.appendChild(bubble);
    const chip = document.createElement('span');
    chip.className = 'from-chip';
    chip.textContent = envelope.from || '?';
    row.appendChild(chip);
    // Color-fetch is async; the chip renders immediately with a neutral
    // fallback tint and is upgraded in place once the sender's own widget
    // color resolves — never blocks/delays the message itself appearing.
    getAgentColor(envelope.from).then((color) => {
      chip.style.background = hexToRgba(color, 0.32);
      chip.style.borderColor = hexToRgba(color, 0.7);
    });
  }
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;

  // Keep the log from growing unbounded.
  while (logEl.children.length > 100) logEl.removeChild(logEl.firstChild);
}

// ── speech (local Kokoro TTS) ────────────────────────────────────────────────
//
// Speak-request convention (also documented in main.js): an inbox envelope
// with "kind": "speak" -> { kind: "speak", from, to, text, voice?, ts }.
// This is our own convention for this pass (PROTOCOL.md doesn't define one
// yet); any future vortexia-side convention should update both places.
//
// Replaced window.speechSynthesis (Chromium's built-in TTS — noticeably
// worse than macOS's own `say` voices, confirmed by the user) with Kokoro-82M
// run locally via kokoro-js: main.js does the ONNX inference (see its "local
// text-to-speech" section) and hands back a WAV buffer for this process to
// play. window.las.ttsVoices replaces speechSynthesis.getVoices() as the pool
// pickVoice() hashes agents into — same function, same locale-fallback
// behavior, just a different (better-sounding, and free) voice source.

// Speak-queue handshake (backend/main.py's _drain_one): the backend drainer
// publishes ONE speak envelope at a time and blocks until this widget says
// it's over — that is what keeps two agents from talking at once, because
// playback happens here, in this agent's own process, where no other agent
// or the backend can hear a clip end. 'started' goes back the moment the
// envelope is received (see onVortexiaMessage), 'done' once the audio ends,
// and 'skipped' (+ reason) on every path where nothing plays — the speaker
// is free either way, and the queue must not sit on the full timeout for a
// muted widget. Envelopes without an id (a pre-handshake publisher) are
// simply played with nothing to ack.
function ackSpeak(envelope, phase, reason) {
  if (!envelope || !envelope.id) return;
  window.las.ackSpeak(envelope.id, phase, reason).catch((err) => console.warn('[widget] ackSpeak failed', err));
}

// The speaker lock (backend/main.py, phase `playing`): right before the audio
// starts, ask whether this clip's turn is still current. A clip whose
// synthesis outlived the drainer's budget is refused — playing it then would
// talk over whoever holds the turn now (four voices at once on 2026-10-14).
// An unreachable backend fails open: there is no queue to respect then.
async function mayPlay(envelope, durationMs) {
  if (!envelope || !envelope.id) return true;
  try {
    const res = await window.las.ackSpeak(envelope.id, 'playing', null, durationMs);
    return !(res && res.ok && res.known === false);
  } catch (err) {
    console.warn('[widget] speaker lock unreachable — playing anyway', err);
    return true;
  }
}

// las/speak is QoS1: a reconnect can redeliver an envelope already played.
const seenSpeakIds = new Set();
function firstTimeSeen(envelope) {
  if (!envelope || !envelope.id) return true;
  if (seenSpeakIds.has(envelope.id)) return false;
  seenSpeakIds.add(envelope.id);
  if (seenSpeakIds.size > 500) seenSpeakIds.delete(seenSpeakIds.values().next().value);
  return true;
}

function audioDurationMs(audioEl) {
  return new Promise((resolve) => {
    const done = () => resolve(Number.isFinite(audioEl.duration) ? Math.round(audioEl.duration * 1000) : null);
    if (audioEl.readyState >= 1) return done();
    audioEl.addEventListener('loadedmetadata', done, { once: true });
    audioEl.addEventListener('error', () => resolve(null), { once: true });
    setTimeout(() => resolve(null), 2000);
  });
}

// Local playback chain: even if two speak envelopes for THIS agent arrive
// back to back (the backend gate already spaces them, but las/speak is an
// open topic), they play one after the other, never on top of each other.
let speakChain = Promise.resolve();

function enqueueSpeak(text, envelope) {
  speakChain = speakChain.then(() => speak(text, envelope)).catch((err) => console.warn('[widget] speak failed', err));
  return speakChain;
}

// The clip playing right now, if any — so muting cuts it off mid-sentence
// instead of only skipping the NEXT one. Synthesis alone takes 10-25s, so
// "mute only applies to clips that haven't started" read as a mute button
// that does nothing.
let currentSpeech = null;

function stopCurrentSpeech() {
  if (currentSpeech) currentSpeech.stop();
}

/** Resolves once the clip has finished playing (or was skipped). */
async function speak(text, envelope) {
  if (prefs.mute) {
    ackSpeak(envelope, 'skipped', 'muted');
    return;
  }
  const pinned = ttsVoice ? window.las.ttsVoices.find((v) => v && v.name === ttsVoice) : null;
  if (ttsVoice && !pinned) console.warn(`[widget] tts_voice "${ttsVoice}" is not in the Kokoro pool — falling back to the hashed voice`);
  const { voice, warning } = pinned ? { voice: pinned, warning: null } : window.las.pickVoice(agentName, locale, window.las.ttsVoices);
  if (warning) console.warn('[widget]', warning);
  if (!voice) {
    ackSpeak(envelope, 'skipped', 'no-voice');
    return;
  }
  let result;
  try {
    result = await window.las.synthesizeSpeech(text, voice.name, voice.kokoroLang);
  } catch (err) {
    console.warn('[widget] synthesizeSpeech IPC failed', err);
    ackSpeak(envelope, 'skipped', 'synthesis-ipc-failed');
    return;
  }
  if (!result || !result.ok) {
    console.warn('[widget] tts synthesis failed', result && result.error);
    ackSpeak(envelope, 'skipped', 'synthesis-failed');
    return;
  }
  // Muted while synthesizing — the slow part — so never start playing.
  if (prefs.mute) {
    ackSpeak(envelope, 'skipped', 'muted');
    return;
  }
  const url = URL.createObjectURL(new Blob([result.wav], { type: 'audio/wav' }));
  const audioEl = new Audio(url);
  if (!(await mayPlay(envelope, await audioDurationMs(audioEl)))) {
    // Refused: its turn is over. Not played, not acked again — the backend
    // already moved on and logged the refusal.
    URL.revokeObjectURL(url);
    console.warn('[widget] speak refused by the queue (turn already ended) — dropped, not played over the next voice');
    return;
  }
  if (prefs.mute) {
    URL.revokeObjectURL(url);
    ackSpeak(envelope, 'skipped', 'muted');
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = (phase, reason) => {
      if (settled) return;
      settled = true;
      if (currentSpeech && currentSpeech.audioEl === audioEl) currentSpeech = null;
      URL.revokeObjectURL(url);
      ackSpeak(envelope, phase, reason);
      resolve();
    };
    currentSpeech = {
      audioEl,
      stop: () => {
        audioEl.pause();
        finish('skipped', 'muted');
      },
    };
    audioEl.addEventListener('ended', () => finish('done'));
    audioEl.addEventListener('error', () => finish('skipped', 'playback-error'));
    audioEl.play().catch((err) => {
      console.warn('[widget] audio playback failed', err);
      finish('skipped', 'play-rejected');
    });
  });
}

// Set by runMicSelfTest() while it's waiting for the live session's "OK"
// reply — see the mic self-test section below. Routed through this shared
// handler (rather than a fresh window.las.onVortexiaMessage() registration
// per self-test) because preload.js exposes no removeListener: registering
// a new one on every double-click would leak an ipcRenderer listener per
// self-test, never cleaned up.
let pendingMicSelfTestResolve = null;

window.las.onVortexiaMessage((envelope) => {
  console.log('[widget] received', JSON.stringify(envelope));
  if (envelope && envelope.kind === 'mic-selftest-pong') {
    // Silent, mechanical confirmation published directly by `las agent
    // listen` itself (cli/commands/agents.py) — proves the mic -> vortexia
    // -> a live terminal-side listener pipe works, independent of whether
    // an LLM session is attached. Deliberately NOT spoken and NOT shown as
    // a chat bubble — an audible/visible "OK" here would misrepresent mere
    // plumbing as a real reply. The audible "OK" below (kind: 'speak') is
    // the separate, optional confirmation that an LLM actually answered.
    if (pendingMicSelfTestResolve && envelope.to === agentName) {
      pendingMicSelfTestResolve(true);
      pendingMicSelfTestResolve = null;
    }
    return;
  }
  if (envelope && envelope.kind === 'speak') {
    if (!firstTimeSeen(envelope)) return;
    appendLogEntry(envelope, { speak: true });
    // Claim it right away — the backend drainer only waits a short grace
    // period for SOMEONE to pick a clip up, then the long playback timeout.
    ackSpeak(envelope, 'started');
    enqueueSpeak(envelope.text || '', envelope);
    if (
      pendingMicSelfTestResolve &&
      envelope.to === agentName &&
      typeof envelope.text === 'string' &&
      envelope.text.trim().toLowerCase() === 'ok'
    ) {
      pendingMicSelfTestResolve(true);
      pendingMicSelfTestResolve = null;
    }
  } else if (envelope && envelope.kind === 'cc') {
    // A for-the-record copy handed to the last-used session of something
    // that went to another session (docs/adr/0005). The original already
    // shows in this log (session inboxes are watched too, see main.js's
    // connectVortexia); showing the copy would double it.
    return;
  } else if (envelope && envelope.kind === 'title-request') {
    // This widget's own refresh button asking a session to title itself —
    // plumbing, not conversation. The answer shows up in the children list.
    return;
  } else if (envelope) {
    appendLogEntry(envelope);
  }
});

window.las.onVortexiaStatus((status) => {
  if (!status.connected) {
    console.warn('[widget] vortexia not connected:', status.error);
  }
});

// ── manual resize (frameless window has no native resize border) ───────────

const resizeHandleEl = document.getElementById('resizeHandle');
let resizing = false;
let lastX = 0;
let lastY = 0;

resizeHandleEl.addEventListener('mousedown', (e) => {
  resizing = true;
  lastX = e.screenX;
  lastY = e.screenY;
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  const dw = e.screenX - lastX;
  const dh = e.screenY - lastY;
  lastX = e.screenX;
  lastY = e.screenY;
  window.las.resizeBy(dw, dh);
});

window.addEventListener('mouseup', () => {
  resizing = false;
});

// ── face buttons ─────────────────────────────────────────────────────────
//
// Restores the buttons the retired Swift widget (widget/tray.swift) had on
// its compact face: speaker (mute toggle), mic (dictation), clear (log),
// open (terminal window / folder at the agent's path — it replaced the
// command palette), and children (which connected session hears the mic —
// it replaced the focus/scope button, whose focus + link-a-TTY job made no
// sense once delivery stopped being a TTY). The gear button/settings panel
// above are untouched — this section is purely additive.

// -- speaker: one-click mute toggle ------------------------------------------

const speakerEl = document.getElementById('speaker');

function updateSpeakerIcon() {
  speakerEl.innerHTML = prefs.mute ? '&#128263;' : '&#128266;'; // 🔇 / 🔊
  speakerEl.classList.toggle('active', !!prefs.mute);
  speakerEl.title = prefs.mute ? 'Unmute' : 'Mute';
}

speakerEl.addEventListener('click', async () => {
  await persist({ mute: !prefs.mute });
});

// -- clear: type "/clear" into the linked terminal(s) ------------------------
//
// Faithful port of the retired Swift clearSession(), which did
// injectToSession("/clear", source: "raw") — literally typing "/clear" into
// the agent's live iTerm2 session(s). That raw-terminal-write mechanism
// (distinct from the retired inter-agent inject/messaging pipeline — see
// main.js's agent:focus/agent:tty-write comments) still exists on the
// backend and still works; an agent can have more than one linked terminal
// open, so this writes to all of them (backend: POST /agents/{name}/tty-write
// with no `tty` -> _find_all_claude_ttys, not just one selected session).
// Also clears this window's own visible log, which is free and harmless.

document.getElementById('clear').addEventListener('click', async () => {
  logEl.innerHTML = '';
  try {
    const result = await window.las.writeToTty(agentName, '/clear');
    if (!result || !result.written || result.written.length === 0) {
      console.warn('[widget] /clear did not reach any linked terminal:', result);
    }
  } catch (err) {
    console.warn('[widget] tty-write failed:', err);
  }
});

// -- mic: dictation via local, offline Whisper transcription ----------------
//
// Chromium's built-in SpeechRecognition/webkitSpeechRecognition is a cloud
// service tied to a Google API key that only official Chrome builds have —
// verified live, it always fails with error:"network" in Electron even
// though getUserMedia (mic access) works fine, and there is no
// flag/permission fix (see main.js's "audio transcription" section for the
// full writeup). Replacement: this still records with MediaRecorder (same
// getUserMedia mic access, same click-to-start/click-to-stop UX as before),
// but instead of a cloud recognizer it decodes the clip to raw PCM here in
// the renderer (Web Audio API — a browser API, no Node/sandbox issue) and
// hands that PCM to main.js's local Whisper pipeline over IPC. A result is
// published to this agent's OWN vortexia inbox (not typed into a live TTY —
// that mechanism is retired) so the /las-agent skill picks it up at the
// start of this agent's next Claude Code session (see CLAUDE.md) — exactly
// the same destination the old SpeechRecognition.onresult used.

const micEl = document.getElementById('mic');
const MAX_RECORDING_MS = 5400000; // 90 min safety net if the user forgets to click stop (long dictations; whisper-base runs ~7x realtime locally, so a full window is ~13 min of transcription)

let mediaRecorder = null;
let recordedChunks = [];
let micState = 'idle'; // 'idle' | 'listening' | 'transcribing'
let maxDurationTimer = null;
let countdownTimers = [];

function setMicState(next) {
  micState = next;
  micEl.classList.toggle('active', next === 'listening');
  micEl.classList.toggle('busy', next === 'transcribing');
  if (next === 'listening') {
    micEl.title = 'Recording… click to stop';
  } else if (next === 'transcribing') {
    micEl.title = 'Transcribing…';
  } else {
    micEl.title = 'Dictate (click to start/stop, double-click to test mic)';
  }
}

// Pushed from main.js during transcribeAudio — distinguishes "downloading
// the model, first use only" from ordinary inference so the button doesn't
// just look frozen on the very first dictation on a machine.
window.las.onAudioStatus((status) => {
  if (micState !== 'transcribing' || !status) return;
  if (status.state === 'loading-model') {
    micEl.title = 'Downloading speech model (first use only)…';
  } else if (status.state === 'transcribing') {
    micEl.title = 'Transcribing…';
  }
});

/**
 * Decode a recorded Blob (webm/opus from MediaRecorder) down to mono 16kHz
 * Float32 PCM — the sample format @xenova/transformers' Whisper ASR
 * pipeline expects. An OfflineAudioContext does the resample in one shot
 * instead of a hand-rolled resampler.
 */
async function blobToMono16kPCM(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const decodeCtx = new AudioCtx();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    decodeCtx.close();
  }
  const targetRate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

// -- countdown beeps across the MAX_RECORDING_MS safety-net window ----------
// Purely a "how much time is left before this gets force-stopped" awareness
// aid, distinct from any transcription/model concern — a calm low pip at the
// halfway point, then rising urgency as the cutoff nears (10s, then 5s)
// before stopRecordingAndTranscribe() fires.

let sharedAudioCtx = null;
function playBeep(freq, durationMs) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!sharedAudioCtx) sharedAudioCtx = new AudioCtx();
    const ctx = sharedAudioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    osc.start(now);
    osc.stop(now + durationMs / 1000 + 0.02);
  } catch (err) {
    console.warn('[widget] mic: beep failed:', err);
  }
}

function scheduleCountdownBeeps() {
  clearCountdownTimers();
  countdownTimers.push(setTimeout(() => playBeep(440, 110), MAX_RECORDING_MS / 2)); // halfway
  countdownTimers.push(setTimeout(() => playBeep(660, 110), MAX_RECORDING_MS - 10000)); // 10s left
  countdownTimers.push(setTimeout(() => playBeep(780, 110), MAX_RECORDING_MS - 5000)); // 5s left
}

function clearCountdownTimers() {
  countdownTimers.forEach(clearTimeout);
  countdownTimers = [];
}

// -- mic self-test (double-click): confirms the mic + dictation pipeline is
// actually live, without having to talk into it and wait for a transcript.
// Answers "me escuchás? estás ok?" instantly instead of after 5 minutes of
// dictating into a dead mic.
//
// A real end-to-end test, not just a canned reply: getUserMedia (mic
// capture) succeeding only gets a neutral 🎙️ toast — it says nothing about
// whether a live Claude Code session is actually attached and listening on
// the other end. An earlier version spoke a hardcoded "OK" back through the
// TTS queue on success, which gave false confidence even with no session
// running at all; a later version fixed the canned reply but still flashed
// 👍 immediately on mic capture alone, before any reply could possibly have
// arrived, which was the same false-positive under a different name. This
// version publishes a real self-dictation ping into the agent's OWN
// vortexia inbox (window.las.sendToSelf — the exact same path a real mic
// dictation uses), then actually WAITS (see waitForMicSelfTestReply, up to
// MIC_SELFTEST_REPLY_TIMEOUT_MS) for a reply before showing 👍 or 👎. Two
// independent, layered confirmations can satisfy that wait:
//   1. `las agent listen` (cli/commands/agents.py) answers the sentinel
//      itself, silently and mechanically, the instant it's received — a
//      'mic-selftest-pong' envelope, no TTS, no LLM involved. This alone
//      proves the mic -> vortexia -> a live terminal-side listener pipe is
//      intact, which is the whole point of a *self*-test: it should not
//      require an LLM to be paying attention just to prove the plumbing
//      works.
//   2. The `las-agent` skill (see CLAUDE.md / its "Escucha en vivo"
//      section) separately tells an attached LLM session to also speak
//      "OK" back out loud on seeing this same sentinel — optional, audible
//      backup coverage on top of #1, not required for 👍.
// If neither arrives in time, that itself is the useful signal — nothing
// at all is listening — and the UI now actually shows 👎 for it instead of
// a thumbs-up regardless.
const MIC_SELFTEST_PING = '[las-mic-selftest] reply with just "OK" to confirm this session is listening.';
const MIC_SELFTEST_REPLY_TIMEOUT_MS = 8000;

// Resolves true if a live session's "OK" comes back in time, false on
// timeout. See pendingMicSelfTestResolve above for how the reply is caught.
// micSelfTestGeneration guards against a double-click fired again while a
// prior self-test is still waiting (micState alone doesn't block this,
// since self-test never leaves 'idle'): without it, the first call's own
// timeout would null out the second call's still-pending resolver.
let micSelfTestGeneration = 0;
function waitForMicSelfTestReply(timeoutMs) {
  const generation = ++micSelfTestGeneration;
  return new Promise((resolve) => {
    let settled = false;
    pendingMicSelfTestResolve = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    setTimeout(() => {
      if (settled) return;
      settled = true;
      if (micSelfTestGeneration === generation) pendingMicSelfTestResolve = null;
      resolve(false);
    }, timeoutMs);
  });
}

function showMicToast(emoji) {
  const toast = document.createElement('span');
  toast.className = 'mic-test-toast';
  toast.textContent = emoji;
  micEl.appendChild(toast);
  toast.addEventListener('animationend', () => toast.remove(), { once: true });
  // Safety net in case animationend never fires (e.g. window backgrounded).
  setTimeout(() => toast.remove(), 1500);
}

async function runMicSelfTest() {
  if (micState !== 'idle') return; // don't interrupt a real recording/transcription
  window.las.log('info', 'mic', 'self-test (double-click): starting');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    window.las.log('error', 'mic', `self-test failed: getUserMedia error: ${err && err.message ? err.message : err}`);
    showMicToast('👎');
    return;
  }
  const track = stream.getAudioTracks()[0];
  const live = !!track && track.readyState === 'live';
  stream.getTracks().forEach((t) => t.stop());
  if (live) {
    window.las.log('info', 'mic', 'self-test ok: mic capture is live — pinging own inbox for a real session to answer');
    // Capture-only feedback, distinct from the round-trip verdict below —
    // this alone used to be shown as 👍, which is exactly the false
    // positive this test exists to catch: mic capture working says nothing
    // about whether a live session is attached to answer.
    showMicToast('🎙️');
    const sendResult = await window.las.sendToSelf(agentName, MIC_SELFTEST_PING);
    if (!sendResult || !sendResult.ok) {
      window.las.log('warn', 'mic', `self-test ping failed to publish: ${sendResult && sendResult.error}`);
      showMicToast('👎');
      return;
    }
    const replied = await waitForMicSelfTestReply(MIC_SELFTEST_REPLY_TIMEOUT_MS);
    if (replied) {
      window.las.log('info', 'mic', 'self-test ok: a live session replied "OK" — round trip confirmed');
      showMicToast('👍');
    } else {
      window.las.log(
        'warn',
        'mic',
        `self-test: mic capture works but no live session answered within ${MIC_SELFTEST_REPLY_TIMEOUT_MS}ms — is a Claude Code session running the las-agent live listener for this agent?`
      );
      showMicToast('👎');
    }
  } else {
    window.las.log('error', 'mic', 'self-test failed: audio track not live');
    showMicToast('👎');
  }
}

async function stopRecordingAndTranscribe() {
  clearCountdownTimers();
  if (maxDurationTimer) {
    clearTimeout(maxDurationTimer);
    maxDurationTimer = null;
  }
  const recorder = mediaRecorder;
  mediaRecorder = null;
  if (!recorder) return;

  window.las.log('info', 'mic', 'stop clicked — flushing recorder');
  await new Promise((resolve) => {
    if (recorder.state === 'inactive') {
      resolve();
      return;
    }
    recorder.addEventListener('stop', resolve, { once: true });
    recorder.stop();
  });
  recorder.stream.getTracks().forEach((track) => track.stop());

  if (!recordedChunks.length) {
    window.las.log('warn', 'mic', 'stop: no audio chunks recorded — nothing to transcribe');
    setMicState('idle');
    return;
  }

  setMicState('transcribing');
  try {
    const blob = new Blob(recordedChunks, { type: recorder.mimeType || 'audio/webm' });
    window.las.log('info', 'mic', `decoding blob: ${blob.size} bytes, type=${blob.type}`);
    const pcm = await blobToMono16kPCM(blob);
    window.las.log('info', 'mic', `decoded: ${pcm.length} samples (~${(pcm.length / 16000).toFixed(1)}s)`);
    // Dictation language is a separate, user-chosen setting (prefs.micLanguage)
    // — NOT derived from the agent's TTS voice locale. An agent can speak
    // back in English (its voice) while the person dictating to it speaks
    // Spanish; coupling the two silently mistranscribed Spanish speech as
    // English whenever an agent's registered voice was English. 'auto' lets
    // Whisper auto-detect (pass no language hint).
    const languageHint = prefs.micLanguage && prefs.micLanguage !== 'auto' ? prefs.micLanguage : null;
    const result = await window.las.transcribeAudio(pcm.buffer, languageHint);
    window.las.log(
      'info',
      'mic',
      `transcribeAudio returned ok=${!!(result && result.ok)} chars=${result && result.text ? result.text.length : 0}`
    );
    if (result && result.ok && result.text) {
      // Publish via vortexia — NOT a direct live write into the linked
      // terminal. An earlier pass here did the opposite (writeToTty first,
      // vortexia only as a fallback), faithfully porting the retired Swift
      // injectToSession's live-TTY-write behavior. Reversed on explicit
      // request: direct terminal injection depends on iTerm2/AppleScript
      // specifically and isn't portable across terminal apps (or platforms —
      // Windows has no equivalent at all), which is exactly the class of
      // mechanism this whole project moved away from in favor of vortexia.
      // The Clear button still uses writeToTty on purpose — "/clear" is
      // meant to act on a live session right now, a different use case from
      // dictation, which is fine landing in the inbox for the /las-agent
      // skill to pick up at the next session start (see CLAUDE.md).
      //
      // Don't also appendLogEntry here — this agent is subscribed to its own
      // inbox topic, so the publish loops back through onVortexiaMessage and
      // displays itself; appending it here too would show the line twice.
      // No target here: WHICH of this agent's sessions hears it (the
      // last-used one, all, or one — the children button) is the agent's
      // own `sessions.target` in its .las-agent.json, applied by the
      // backend when it routes the send (docs/adr/0005).
      const sendResult = await window.las.sendToSelf(agentName, result.text);
      if (!sendResult || !sendResult.ok) {
        window.las.log('error', 'mic', `failed to publish dictation to own inbox: ${sendResult && sendResult.error}`);
        console.warn('[widget] mic: failed to publish dictation to own inbox:', sendResult && sendResult.error);
      } else if (sendResult.fallback_from) {
        window.las.log('warn', 'mic', `target ${sendResult.fallback_from} is not connected — the dictation went to the last-used session`);
      }
    } else if (result && !result.ok) {
      window.las.log('error', 'mic', `transcription failed: ${result.error}`);
      console.warn('[widget] mic: transcription failed:', result.error);
    } else {
      window.las.log('warn', 'mic', 'transcription returned ok but empty text — nothing published');
    }
  } catch (err) {
    window.las.log('error', 'mic', `transcription pipeline failed: ${err && err.stack ? err.stack : err}`);
    console.warn('[widget] mic: transcription pipeline failed:', err);
  } finally {
    setMicState('idle');
  }
}

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    window.las.log('error', 'mic', `getUserMedia failed: ${err && err.message ? err.message : err}`);
    console.warn('[widget] mic: getUserMedia failed:', err);
    return;
  }
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size) recordedChunks.push(e.data);
  });
  mediaRecorder.start();
  setMicState('listening');
  window.las.log('info', 'mic', 'recording started');
  maxDurationTimer = setTimeout(() => {
    window.las.log('warn', 'mic', `max recording duration (${MAX_RECORDING_MS}ms) hit — auto-stopping`);
    stopRecordingAndTranscribe();
  }, MAX_RECORDING_MS);
  scheduleCountdownBeeps();
}

// Single click toggles start/stop; double-click runs the self-test instead.
// Click events fire immediately (no built-in delay), so a plain 'click'
// listener would act on BOTH clicks of a double-click before 'dblclick' ever
// fires. Standard workaround: delay the single-click action briefly and
// cancel it if a second click arrives in time.
let micClickTimer = null;
micEl.addEventListener('click', (e) => {
  if (e.detail >= 2) return; // handled by dblclick below
  micClickTimer = setTimeout(() => {
    micClickTimer = null;
    if (micState === 'listening') {
      stopRecordingAndTranscribe();
    } else if (micState === 'idle') {
      startRecording();
    }
    // clicks while 'transcribing' are ignored — nothing meaningful to toggle
  }, 220);
});

micEl.addEventListener('dblclick', () => {
  if (micClickTimer) {
    clearTimeout(micClickTimer);
    micClickTimer = null;
  }
  runMicSelfTest();
});

// -- children: which connected session (Claude, Codex, shell) hears the mic -
//
// An agent's connected runtimes are its children (docs/adr/0005, ADR 0004
// phase 2): a Claude, a Codex, a plain shell — each a session (`las agent
// sessions`). Click, hold or right-click the button for the list: 'default'
// = the last-used one (through the agent mailbox its bridge holds), 'all' =
// every connected session, or one of them; plus a "copy the last-used
// session" toggle — a for-the-record cc when the mic talks to the shell, so
// the intelligent session keeps track. The choice is the AGENT's, not this
// window's: it is written to its .las-agent.json (`sessions.target`,
// `sessions.cc_default`) through the backend — the same file `las agent
// target` writes and the backend reads when it routes a plain send — so the
// mic sends with no target of its own (see stopRecordingAndTranscribe). The
// self-test goes the same way: it tests the path the mic actually takes.
// Same inline menu pattern as the Open button. It replaced the focus/scope
// button (focus a TTY, link a TTY): delivery is vortexia, not a TTY.

const childrenEl = document.getElementById('children');
const childrenMenuEl = document.getElementById('childrenMenu');
const TARGET_LABELS = { default: 'Last used session', all: 'All sessions' };
let childrenMenuOpen = false;
let childrenLongPressTimer = null;
let childrenLongPressFired = false;
let knownSessions = [];
let sessionsPolicy = { target: 'default', cc_default: false };

function sessionLabel(s) {
  const brain = s.intelligent === false ? ' · commands only' : '';
  const name = s.title ? ` · ${s.title}` : ` · ${String(s.sid).split('-')[1] || s.sid}`;
  return `${s.runtime || '?'}${name}${brain}${s.default ? ' · last used' : ''}`;
}

/**
 * The choices, as {value, label, scope?, sid?, alias?}: the two fixed ones,
 * then one row per connected session (`sid` = the session it stands for).
 * A runtime with a single session gets a row valued by the runtime name (what `las agent target shell` writes: it
 * survives that terminal being reopened with a new session id, which a sid
 * never would). A runtime with several sessions gets one row per session,
 * valued by its id — no extra "group" row, which read as one more session.
 * `alias` lets a runtime-valued target (e.g. "codex" set from the CLI)
 * still light up the session it resolves to (the most recent one). The
 * same list feeds the menu and the settings <select>, so both always agree.
 */
function targetRows() {
  const rows = [
    { value: 'default', label: TARGET_LABELS.default },
    { value: 'all', label: TARGET_LABELS.all + (knownSessions.length ? ` (${knownSessions.length})` : '') },
  ];
  const byRuntime = new Map();
  for (const s of knownSessions) {
    const runtime = s.runtime || '?';
    if (!byRuntime.has(runtime)) byRuntime.set(runtime, []);
    byRuntime.get(runtime).push(s);
  }
  for (const [runtime, sessions] of byRuntime) {
    if (sessions.length === 1) {
      rows.push({ value: runtime, label: sessionLabel(sessions[0]), scope: sessions[0].scope, sid: sessions[0].sid });
      continue;
    }
    // knownSessions is most-recently-used first: sessions[0] is what the runtime name resolves to.
    sessions.forEach((s, i) => rows.push({ value: s.sid, label: sessionLabel(s), scope: s.scope, sid: s.sid, alias: i === 0 ? runtime : undefined }));
  }
  return rows;
}

/** Does `row` stand for the `target` value (its own value, or the runtime it is the current pick of)? */
function rowMatches(row, target) {
  return row.value === target || (row.alias !== undefined && row.alias === target);
}

/** Human label of a target value: one of the rows, or "not connected". */
function targetLabel(target) {
  const row = targetRows().find((r) => rowMatches(r, target));
  return row ? row.label.trim() : `${target} (not connected)`;
}

function syncMicTargetSelect() {
  const target = sessionsPolicy.target || 'default';
  // Keep the settings <select> honest: exactly the rows the menu shows.
  micTargetEl.innerHTML = '';
  const rows = targetRows();
  const aliased = rows.find((r) => r.value !== target && rowMatches(r, target));
  if (aliased) aliased.value = target; // the select must hold the exact value the file says
  else if (!rows.some((r) => r.value === target)) rows.push({ value: target, label: targetLabel(target) });
  for (const row of rows) {
    const opt = document.createElement('option');
    opt.value = row.value;
    opt.textContent = row.label.trim();
    micTargetEl.appendChild(opt);
  }
  micTargetEl.value = target;
  ccDefaultEl.checked = !!sessionsPolicy.cc_default;
  updateChildrenButton();
}

function updateChildrenButton() {
  const target = sessionsPolicy.target || 'default';
  childrenEl.classList.toggle('active', target !== 'default');
  const cc = sessionsPolicy.cc_default ? ', cc to the last-used session' : '';
  childrenEl.title = `Children: the mic talks to ${targetLabel(target)}${cc} — click or hold to choose`;
}

/** Refresh the connected sessions AND the agent's target/cc choice (same backend view). */
async function refreshSessions() {
  try {
    const view = await window.las.getAgentSessions(agentName);
    knownSessions = Array.isArray(view && view.sessions) ? view.sessions : [];
    // target: null = the backend could not be asked; keep the last known choice.
    if (view && typeof view.target === 'string') sessionsPolicy = { target: view.target, cc_default: !!view.cc_default };
  } catch {
    knownSessions = [];
  }
  return knownSessions;
}

/** Write {target?, cc_default?} to the agent's .las-agent.json (via the backend) and re-sync every view of it. */
async function setSessionsConfig(patch) {
  const view = await window.las.setSessionsConfig(agentName, patch);
  if (view && view.sessions && typeof view.sessions.target === 'string') {
    sessionsPolicy = { target: view.sessions.target, cc_default: !!view.sessions.cc_default };
  } else {
    window.las.log('warn', 'children', `could not save sessions config ${JSON.stringify(patch)} — is the backend up?`);
  }
  syncMicTargetSelect();
}

registerDrawer('children', childrenMenuEl, () => { childrenMenuOpen = false; });

function closeChildrenMenu() {
  childrenMenuOpen = false;
  closeDrawer('children');
}

async function showChildrenMenu() {
  childrenMenuOpen = true;
  childrenMenuEl.innerHTML = '<div class="open-row"><span class="open-label">Loading sessions…</span></div>';
  openDrawer('children');
  await refreshSessions();
  if (!childrenMenuOpen) return; // closed (or replaced) while loading
  syncMicTargetSelect();
  renderChildrenMenu();
  fitWindowToDrawer();
}

function renderChildrenMenu() {
  const current = sessionsPolicy.target || 'default';
  const rows = targetRows();
  childrenMenuEl.innerHTML = '';
  if (!knownSessions.length) {
    const hint = document.createElement('div');
    hint.className = 'open-row';
    hint.innerHTML = '<span class="open-label" style="opacity:.7">No connected sessions — open one with las claude / las codex / las shell</span>';
    childrenMenuEl.appendChild(hint);
  }
  for (const row of rows) {
    const el = document.createElement('div');
    const isCurrent = rowMatches(row, current);
    el.className = 'open-row' + (isCurrent ? ' default' : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'open-label';
    btn.textContent = row.label;
    btn.title = (row.scope ? `${row.scope} — ` : '') + (isCurrent ? 'the mic talks here now' : 'send the mic here');
    btn.addEventListener('click', async () => {
      await setSessionsConfig({ target: row.value });
      closeChildrenMenu();
    });
    el.appendChild(btn);
    if (row.sid) el.append(...sessionActionButtons(row.sid));
    childrenMenuEl.appendChild(el);
  }
  if (knownSessions.some((s) => s.intelligent !== false)) {
    const refreshRow = document.createElement('div');
    refreshRow.className = 'open-row';
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'open-label';
    refreshBtn.textContent = '↻ Refresh descriptions';
    refreshBtn.title = 'Ask every Claude/Codex session what it is working on (a shell cannot describe itself)';
    refreshBtn.addEventListener('click', () => requestSessionTitles(refreshBtn));
    refreshRow.appendChild(refreshBtn);
    childrenMenuEl.appendChild(refreshRow);
  }
}

/** Re-read the sessions and redraw the menu, if it is still open. */
async function reloadChildrenMenu() {
  await refreshSessions();
  if (!childrenMenuOpen) return;
  syncMicTargetSelect();
  renderChildrenMenu();
  fitWindowToDrawer();
}

const CLOSE_CONFIRM_MS = 3000;

function iconButton(text, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'open-move';
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Per-session buttons: find (the terminal gets a beacon title + bell and,
 * in Ghostty, is focused — window to front, Space switched) and close (its
 * tty is hung up, like closing the window). Close takes a second click
 * within CLOSE_CONFIRM_MS: no modal dialog, no accidental kill.
 */
function sessionActionButtons(sid) {
  const find = iconButton('⌖', 'Find this terminal — bring it to the front', async () => {
    const res = await window.las.findSession(agentName, sid);
    if (res && res.focused) closeChildrenMenu();
    else find.title = res && res.ok ? 'Look for the terminal titled "◉ … here ◉" (it rang its bell)' : 'Could not reach this terminal';
  });
  let armed = null;
  const close = iconButton('✕', 'Close this terminal', async () => {
    if (!armed) {
      close.classList.add('armed');
      close.title = 'Click again to close it';
      armed = setTimeout(() => { armed = null; close.classList.remove('armed'); close.title = 'Close this terminal'; }, CLOSE_CONFIRM_MS);
      return;
    }
    clearTimeout(armed);
    armed = null;
    await window.las.closeSession(agentName, sid);
    await reloadChildrenMenu();
  });
  return [find, close];
}

/**
 * Ask each intelligent child to title itself (backend
 * request_session_titles). The answers come back asynchronously — each
 * session runs `las agent title` when it gets to it — so re-read the list a
 * few times while the menu stays open.
 */
async function requestSessionTitles(btn) {
  btn.disabled = true;
  btn.textContent = '↻ Asking sessions…';
  const res = await window.las.requestSessionTitles(agentName);
  if (!res || !Array.isArray(res.asked)) {
    window.las.log('warn', 'children', 'could not ask sessions for titles — is the backend up?');
    btn.textContent = '↻ Refresh failed — backend down?';
    btn.disabled = false;
    return;
  }
  for (const delay of [3000, 5000, 7000, 15000]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (!childrenMenuOpen) return;
    await reloadChildrenMenu();
  }
}

function cancelChildrenLongPress() {
  if (childrenLongPressTimer) clearTimeout(childrenLongPressTimer);
  childrenLongPressTimer = null;
}

childrenEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  childrenLongPressFired = false;
  cancelChildrenLongPress();
  childrenLongPressTimer = setTimeout(() => {
    childrenLongPressTimer = null;
    childrenLongPressFired = true;
    showChildrenMenu();
  }, OPEN_LONG_PRESS_MS);
});
childrenEl.addEventListener('mouseup', cancelChildrenLongPress);
childrenEl.addEventListener('mouseleave', cancelChildrenLongPress);
childrenEl.addEventListener('click', () => {
  if (childrenLongPressFired) {
    // The release of a hold that already opened the menu: keep it open.
    childrenLongPressFired = false;
    return;
  }
  if (childrenMenuOpen) closeChildrenMenu();
  else showChildrenMenu();
});
childrenEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (childrenMenuOpen) closeChildrenMenu();
  else showChildrenMenu();
});
document.addEventListener('mousedown', (e) => {
  if (!childrenMenuOpen) return;
  if (childrenMenuEl.contains(e.target) || childrenEl.contains(e.target)) return;
  closeChildrenMenu();
});

// -- open: a NEW terminal window, or the folder, at this agent's path -------
//
// Replaces the retired command palette (saved-command list + edit form).
// Two actions only, both anchored on the agent's registered directory —
// main.js's agent:open resolves it from the backend registry, nothing is
// typed in here:
//   terminal — a new window of the default terminal, shell in that folder
//   folder   — that folder in the file manager
// A plain click runs the DEFAULT action: whichever is first in
// prefs.openOrder. Press-and-hold (or right-click) shows a small inline
// menu listing both, in order; each row runs its action, and ▲/▼ move it —
// the top row is the default, persisted per agent like any other pref.

const openEl = document.getElementById('open');
const openMenuEl = document.getElementById('openMenu');
const OPEN_ACTION_LABELS = { terminal: 'Terminal', folder: 'Folder' };
const DEFAULT_OPEN_ORDER = ['terminal', 'folder'];
const OPEN_LONG_PRESS_MS = 600;

/** prefs.openOrder, sanitized: unknown entries dropped, duplicates collapsed,
 * missing actions appended in default order — so a stale/garbled pref can
 * never hide an action or leave the click with nothing to run. */
function currentOpenOrder() {
  const saved = Array.isArray(prefs.openOrder) ? prefs.openOrder : [];
  const order = saved.filter((action, i) => DEFAULT_OPEN_ORDER.includes(action) && saved.indexOf(action) === i);
  for (const action of DEFAULT_OPEN_ORDER) {
    if (!order.includes(action)) order.push(action);
  }
  return order;
}

let openMenuOpen = false;
let openLongPressTimer = null;
let openLongPressFired = false;
let openTerminalAppName = '';

async function runOpenAction(action) {
  closeOpenMenu();
  try {
    const result = await window.las.openAgent(agentName, action);
    if (!result || !result.ok) console.warn(`[widget] open ${action} failed:`, result);
  } catch (err) {
    console.warn(`[widget] open ${action} failed:`, err);
  }
}

registerDrawer('open', openMenuEl, () => {
  openMenuOpen = false;
  openEl.classList.remove('active');
});

function closeOpenMenu() {
  openMenuOpen = false;
  openEl.classList.remove('active');
  closeDrawer('open');
}

async function showOpenMenu() {
  openMenuOpen = true;
  openEl.classList.add('active');
  if (!openTerminalAppName) {
    try {
      openTerminalAppName = (await window.las.getDefaultTerminalApp()) || '';
    } catch {
      openTerminalAppName = '';
    }
  }
  if (!openMenuOpen) return; // closed while resolving the terminal name
  renderOpenMenu();
  openDrawer('open');
}

function renderOpenMenu() {
  const order = currentOpenOrder();
  openMenuEl.innerHTML = '';
  order.forEach((action, index) => {
    const row = document.createElement('div');
    row.className = 'open-row' + (index === 0 ? ' default' : '');

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'open-label';
    label.textContent = OPEN_ACTION_LABELS[action] + (action === 'terminal' && openTerminalAppName ? ` · ${openTerminalAppName}` : '');
    label.title = index === 0 ? 'Default — what a plain click runs' : 'Run';
    label.addEventListener('click', () => runOpenAction(action));
    row.appendChild(label);

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'open-move';
    up.textContent = '▲';
    up.title = 'Move up (top = default)';
    up.disabled = index === 0;
    up.addEventListener('click', () => moveOpenAction(index, index - 1));
    row.appendChild(up);

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'open-move';
    down.textContent = '▼';
    down.title = 'Move down';
    down.disabled = index === order.length - 1;
    down.addEventListener('click', () => moveOpenAction(index, index + 1));
    row.appendChild(down);

    openMenuEl.appendChild(row);
  });
}

async function moveOpenAction(from, to) {
  const order = currentOpenOrder();
  if (to < 0 || to >= order.length || from === to) return;
  const [item] = order.splice(from, 1);
  order.splice(to, 0, item);
  await persist({ openOrder: order });
  renderOpenMenu();
  fitWindowToDrawer();
}

function cancelOpenLongPress() {
  if (openLongPressTimer) clearTimeout(openLongPressTimer);
  openLongPressTimer = null;
}

openEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  openLongPressFired = false;
  cancelOpenLongPress();
  openLongPressTimer = setTimeout(() => {
    openLongPressTimer = null;
    openLongPressFired = true;
    showOpenMenu();
  }, OPEN_LONG_PRESS_MS);
});
openEl.addEventListener('mouseup', cancelOpenLongPress);
openEl.addEventListener('mouseleave', cancelOpenLongPress);

openEl.addEventListener('click', () => {
  if (openLongPressFired) {
    // The hold already opened the menu; this is the release of that press.
    openLongPressFired = false;
    return;
  }
  if (openMenuOpen) {
    closeOpenMenu();
    return;
  }
  runOpenAction(currentOpenOrder()[0]);
});

openEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (openMenuOpen) closeOpenMenu();
  else showOpenMenu();
});

// Click anywhere else dismisses the menu.
document.addEventListener('mousedown', (e) => {
  if (!openMenuOpen) return;
  if (openMenuEl.contains(e.target) || openEl.contains(e.target)) return;
  closeOpenMenu();
});
