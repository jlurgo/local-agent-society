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

  const stackOf = (side, displayId) => bubbles.filter((b) => b.side === side && b.displayId === displayId);

  function relayout(side, displayId) {
    const stack = stackOf(side, displayId);
    const display = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
    const positions = stackPositions(display.workArea, stack.map((b) => b.height), side);
    stack.forEach((b, i) => {
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
    relayout(b.side, b.displayId);
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
  function show({ agentName, text, color, opacity, side, display }) {
    const displayId = display.id;
    const stack = stackOf(side, displayId);
    while (stack.length >= BUBBLE_MAX_PER_STACK) close(stack.shift());

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

    const b = { win, agentName, side, displayId, height: BUBBLE_MIN_HEIGHT, timer: null, pinned: false, voice: false, closing: false };
    bubbles.push(b);
    win.loadFile(path.join(sources.bubbleDir, 'bubble.html'), {
      query: { agent: agentName, text, color, opacity: String(opacity), side },
    });
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      relayout(side, displayId);
      win.showInactive();
      armTimer(b);
    });
    win.on('closed', () => {
      forget(b);
      relayout(side, displayId);
    });
    log.info('bubble', `${agentName}: ${side} (${text.length} chars)`);
    return b;
  }

  /** ipcMain 'bubble:action' handler. */
  function handle(event, kind, payload = {}) {
    const b = bubbles.find((o) => !o.win.isDestroyed() && o.win.webContents === event.sender);
    if (!b) return;
    switch (kind) {
      case 'size':
        b.height = clampHeight(payload.height);
        relayout(b.side, b.displayId);
        return;
      case 'pin':
        b.pinned = Boolean(payload.on);
        armTimer(b);
        return;
      case 'dismiss':
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

  function closeAll() {
    for (const b of [...bubbles]) close(b);
  }

  return { show, handle, micStatus, closeAll, count: () => bubbles.length };
}

module.exports = { createBubbles, stackPositions, BUBBLE_WIDTH, BUBBLE_TTL_MS, BUBBLE_MAX_PER_STACK };
