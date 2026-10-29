'use strict';
/**
 * Speech bubbles — what an agent just said, shown at the edge of the screen
 * on the side its Space lies, when its widget is NOT on the Space you are
 * looking at (otherwise the face itself shows the text).
 *
 * Each bubble is its own small always-on-top window, visible on every Space,
 * in the agent's color, piled up from the BOTTOM corner of the side it
 * belongs to — newest at the bottom, older ones pushed up (one pile per
 * display per side; the top of the screen is where the widgets themselves
 * tend to live, and a bubble over a widget read as part of it). It never takes focus when it
 * appears (showInactive) — typing into the text reply focuses it, nothing
 * else does. It goes away on its own after BUBBLE_TTL_MS unless the pointer
 * is over it or a text reply is open, on ✕, after a reply is sent, or when
 * its stack is full and it is the oldest.
 *
 * Decisions (what a click means) are main.js's — the bubble only reports
 * them (`bubble:action` from bubble-preload.js) and this module routes them
 * to the `onAction` callback with the agent's name:
 *   open       — the body was clicked: go to that agent (its Space)
 *   voice      — answer by voice: the agent's widget starts a dictation
 *                (unseen, on its own Space); the bubble stays, becomes the
 *                face of that dictation (micStatus) and shows its phases
 *   mic-stop   — stop the dictation and send it
 *   mic-cancel — stop it and send nothing
 *   reply      — answer by text: { text }
 *   dismiss, pin { on }, size { height } — housekeeping, handled here
 */
const { BrowserWindow, screen } = require('electron');
const path = require('node:path');

const BUBBLE_WIDTH = 340;
const BUBBLE_MIN_HEIGHT = 72;
const BUBBLE_MAX_HEIGHT = 320;
const BUBBLE_MARGIN = 10;     // from the screen edge, and between stacked bubbles
const BUBBLE_BOTTOM = 12;     // above the Dock / bottom of the work area
const BUBBLE_TTL_MS = 20000;
const BUBBLE_MAX_PER_STACK = 5;

/**
 * Pure: the bounds of each bubble of one pile, in the order given (oldest
 * first), hugging the given side of the work area and piled up from its
 * bottom edge: the LAST bubble sits at the bottom, each earlier one above
 * the next.
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {number[]} heights
 * @param {'left'|'right'} side
 */
function stackPositions(workArea, heights, side, width = BUBBLE_WIDTH) {
  const x = side === 'left' ? workArea.x + BUBBLE_MARGIN : workArea.x + workArea.width - width - BUBBLE_MARGIN;
  let y = workArea.y + workArea.height - BUBBLE_BOTTOM;
  const out = new Array(heights.length);
  for (let i = heights.length - 1; i >= 0; i--) {
    y -= heights[i];
    out[i] = { x, y, width, height: heights[i] };
    y -= BUBBLE_MARGIN;
  }
  return out;
}

/**
 * Pure: bubbles beside a widget (its bounds = anchor), top-aligned with it,
 * to its right when that fits on the work area, else to its left; piled
 * downward. The tail side follows: 'left' when the bubble is to the right.
 */
function anchorPositions(workArea, anchor, heights, width = BUBBLE_WIDTH) {
  const toRight = anchor.x + anchor.width + BUBBLE_MARGIN + width <= workArea.x + workArea.width;
  const x = toRight ? anchor.x + anchor.width + BUBBLE_MARGIN : anchor.x - width - BUBBLE_MARGIN;
  let y = Math.max(workArea.y, anchor.y);
  return heights.map((height) => {
    const bounds = { x, y, width, height };
    y += height + BUBBLE_MARGIN;
    return bounds;
  });
}
function anchorSide(workArea, anchor, width = BUBBLE_WIDTH) {
  return anchor.x + anchor.width + BUBBLE_MARGIN + width <= workArea.x + workArea.width ? 'left' : 'right';
}

function clampHeight(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return BUBBLE_MIN_HEIGHT;
  return Math.round(Math.min(BUBBLE_MAX_HEIGHT, Math.max(BUBBLE_MIN_HEIGHT, n)));
}

/**
 * @param {{sources: {bubbleDir: string, bubblePreloadPath: string}, log: object,
 *          onAction: (kind: string, agentName: string, payload: object) => void}} opts
 */
function createBubbles({ sources, log, onAction }) {
  /** @type {Array<{win: BrowserWindow, agentName: string, side: string, displayId: number, height: number, timer: any, pinned: boolean}>} */
  const bubbles = [];

  // A pile is keyed by screen edge ('left'/'right') — or, for an agent whose
  // widget is on the Space being looked at, by that agent: those bubbles pop
  // out beside the widget itself (anchorPositions), not at a corner.
  const stackOf = (stack, displayId) => bubbles.filter((b) => b.stack === stack && b.displayId === displayId);

  function relayout(stack, displayId) {
    const pile = stackOf(stack, displayId);
    const display = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
    const anchor = pile.length ? pile[0].anchor : null;
    const positions = anchor
      ? anchorPositions(display.workArea, anchor, pile.map((b) => b.height))
      : stackPositions(display.workArea, pile.map((b) => b.height), stack);
    pile.forEach((b, i) => {
      if (!b.win.isDestroyed()) b.win.setBounds(positions[i]);
    });
  }

  function forget(b) {
    const i = bubbles.indexOf(b);
    if (i !== -1) bubbles.splice(i, 1);
    clearTimeout(b.timer);
  }

  function close(b) {
    forget(b);
    if (!b.win.isDestroyed()) b.win.close();
    relayout(b.stack, b.displayId);
  }

  function armTimer(b) {
    // A bubble on its way out keeps its close timer: a hover (pin) after
    // 'sent' must not cancel it — that left a bubble nobody could dismiss.
    if (b.closing) return;
    clearTimeout(b.timer);
    if (b.pinned) return;
    b.timer = setTimeout(() => close(b), BUBBLE_TTL_MS);
  }

  /**
   * @param {{agentName: string, text: string, color: string, opacity: number,
   *          side: 'left'|'right', display: Electron.Display}} spec
   */
  function show({ agentName, text, color, opacity, side, display, anchor = null, speakId = null }) {
    const displayId = display.id;
    if (anchor) side = anchorSide(display.workArea, anchor);
    const stackKey = anchor ? `anchor:${agentName}` : side;
    const pile = stackOf(stackKey, displayId);
    while (pile.length >= BUBBLE_MAX_PER_STACK) close(pile.shift());

    const win = new BrowserWindow({
      width: BUBBLE_WIDTH,
      height: BUBBLE_MIN_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      focusable: true,
      webPreferences: {
        preload: sources.bubblePreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Above the widgets (which are plain always-on-top) and visible on the
    // Space being looked at — that is the whole point.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    const b = { win, agentName, side, stack: stackKey, anchor, speakId, displayId, height: BUBBLE_MIN_HEIGHT, timer: null, pinned: false, voice: false, closing: false };
    bubbles.push(b);
    win.loadFile(path.join(sources.bubbleDir, 'bubble.html'), {
      query: { agent: agentName, text, color, opacity: String(opacity), side },
    });
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      relayout(stackKey, displayId);
      win.showInactive();
      armTimer(b);
    });
    win.on('closed', () => {
      forget(b);
      relayout(stackKey, displayId);
    });
    log.info('bubble', `${agentName}: ${anchor ? 'beside the widget' : side} (${text.length} chars)`);
    return b;
  }

  /** ipcMain 'bubble:action' handler. */
  function handle(event, kind, payload = {}) {
    const b = bubbles.find((o) => !o.win.isDestroyed() && o.win.webContents === event.sender);
    if (!b) return;
    switch (kind) {
      case 'size':
        b.height = clampHeight(payload.height);
        relayout(b.stack, b.displayId);
        return;
      case 'pin':
        b.pinned = Boolean(payload.on);
        armTimer(b);
        return;
      case 'dismiss':
      case 'mute':
        // Closing a bubble silences what it shows; 🔇 is the same, said plainly.
        onAction('mute', b.agentName, payload);
        close(b);
        return;
      case 'voice':
        b.voice = true;          // from now on this bubble shows the dictation
        b.pinned = true;
        armTimer(b);
        onAction(kind, b.agentName, payload);
        return;
      case 'mic-stop':
        onAction(kind, b.agentName, payload);
        return;
      case 'mic-cancel':
        // The row's ✕ always gets the user out: cancel whatever the widget
        // is doing for this bubble, and close.
        onAction(kind, b.agentName, payload);
        close(b);
        return;
      case 'open':
      case 'reply':
        onAction(kind, b.agentName, payload);
        close(b);
        return;
      default:
        log.warn('bubble', `${b.agentName}: unknown action ${kind}`);
    }
  }

  /**
   * A widget's dictation phase, for the bubble(s) of that agent that asked
   * for it (`voice`): shown in place; the bubble holds while listening or
   * transcribing, closes shortly after 'sent', stays (and resumes its
   * timer) after 'failed' or 'cancelled'.
   */
  function micStatus(agentName, state, detail) {
    for (const b of bubbles) {
      if (b.agentName !== agentName || !b.voice || b.closing || b.win.isDestroyed()) continue;
      b.win.webContents.send('bubble:mic', state, detail || null);
      if (state === 'listening' || state === 'partial' || state === 'transcribing') {
        b.pinned = true;
        armTimer(b);
      } else if (state === 'sent') {
        b.closing = true;
        clearTimeout(b.timer);
        b.timer = setTimeout(() => close(b), 1500);
      } else if (state === 'failed' || state === 'cancelled') {
        // The widget is not recording for this bubble (any more): back to a
        // plain bubble that fades on its own.
        b.voice = false;
        b.pinned = false;
        armTimer(b);
      }
    }
  }

  /** The agent stopped talking (its speak turn ended): its bubble goes away —
   * unless someone is using it (hovering, typing, dictating). */
  function speakEnded(speakId) {
    for (const b of bubbles) {
      if (b.speakId !== speakId || b.closing || b.win.isDestroyed()) continue;
      if (b.pinned || b.voice) continue;
      b.closing = true;
      clearTimeout(b.timer);
      b.timer = setTimeout(() => close(b), 800);
    }
  }

  function closeAll() {
    for (const b of [...bubbles]) close(b);
  }

  return { show, handle, micStatus, speakEnded, closeAll, count: () => bubbles.length };
}

module.exports = { createBubbles, stackPositions, anchorPositions, BUBBLE_WIDTH, BUBBLE_TTL_MS, BUBBLE_MAX_PER_STACK };
