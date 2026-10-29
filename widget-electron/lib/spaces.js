'use strict';

/**
 * macOS Space (virtual desktop) read/move for OUR OWN BrowserWindows only.
 *
 * There is no supported Electron/AppKit API for "which Space is this window
 * on" or "move this window to Space N" — see the reasoning in the widget
 * task history. This uses the same private CGS (CoreGraphics Services)
 * calls that window-management tools like yabai/Rectangle rely on:
 *   CGSMainConnectionID, CGSCopySpacesForWindows, CGSMoveWindowsToManagedSpace
 * loaded via koffi (an N-API FFI library — no native addon build step, no
 * node-gyp/electron-rebuild, works across Electron's bundled Node ABI).
 *
 * Verified live (spike, see task history) two important, distinct things:
 *   - Moving ANOTHER process's window (e.g. iTerm2) from an external script
 *     is refused by macOS — confirmed it silently no-ops.
 *   - Moving a window OWNED BY THIS SAME PROCESS (an Electron BrowserWindow,
 *     from within the Electron main/browser process) DOES work.
 * This module is only ever used on this app's own windows for exactly that
 * reason — it must never be pointed at another process's window (e.g. the
 * agent's linked iTerm2 terminal), which both wouldn't work and isn't the
 * point: only the widget's own position/Space should be restored, nothing
 * about the agent's terminal.
 *
 * macOS-only, fails soft everywhere: any error (wrong macOS version renamed
 * a symbol, sandboxed context, etc.) just means space memory silently
 * doesn't work, never a crash or a thrown error the caller has to handle.
 */

const supported = process.platform === 'darwin';

let cf = null;
let sl = null;
let fns = null;
let cid = null;
let initError = null;

function init() {
  if (fns || initError) return;
  try {
    cf = require('koffi').load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    sl = require('koffi').load('/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight');

    const CFNumberCreate = cf.func('void* CFNumberCreate(void*, int, void*)');
    const CFArrayCreate = cf.func('void* CFArrayCreate(void*, void**, long, void*)');
    const CFArrayGetCount = cf.func('long CFArrayGetCount(void*)');
    const CFArrayGetValueAtIndex = cf.func('void* CFArrayGetValueAtIndex(void*, long)');
    const CFNumberGetValue = cf.func('unsigned char CFNumberGetValue(void*, int, void*)');

    const CGSMainConnectionID = sl.func('unsigned int CGSMainConnectionID()');
    const CGSCopySpacesForWindows = sl.func('void* CGSCopySpacesForWindows(unsigned int, int, void*)');
    const CGSMoveWindowsToManagedSpace = sl.func('void CGSMoveWindowsToManagedSpace(unsigned int, void*, unsigned long long)');
    const CGSCopyManagedDisplayForWindow = sl.func('void* CGSCopyManagedDisplayForWindow(unsigned int, unsigned int)');
    const CGSManagedDisplayGetCurrentSpace = sl.func('unsigned long long CGSManagedDisplayGetCurrentSpace(unsigned int, void*)');
    const CGSCopyManagedDisplaySpaces = sl.func('void* CGSCopyManagedDisplaySpaces(unsigned int)');
    const CFDictionaryGetValue = cf.func('void* CFDictionaryGetValue(void*, void*)');
    const CFStringCreateWithCString = cf.func('void* CFStringCreateWithCString(void*, const char*, unsigned int)');
    const CFRelease = cf.func('void CFRelease(void*)');

    fns = {
      CFNumberCreate,
      CFArrayCreate,
      CFArrayGetCount,
      CFArrayGetValueAtIndex,
      CFNumberGetValue,
      CGSCopySpacesForWindows,
      CGSMoveWindowsToManagedSpace,
      CGSCopyManagedDisplayForWindow,
      CGSManagedDisplayGetCurrentSpace,
      CGSCopyManagedDisplaySpaces,
      CFDictionaryGetValue,
      CFStringCreateWithCString,
      CFRelease,
    };
    cid = CGSMainConnectionID();
  } catch (err) {
    initError = err;
    console.warn('[widget] spaces: init failed, window-Space memory disabled:', err);
  }
}

const kCFNumberSInt32Type = 3;
const kCFNumberSInt64Type = 4;
const kCGSAllSpacesMask = 7;
const kCFStringEncodingUTF8 = 0x08000100;

function makeSingleWindowIdArray(koffi, windowId) {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(windowId, 0);
  const num = fns.CFNumberCreate(null, kCFNumberSInt32Type, buf);
  const ptrBuf = koffi.alloc('void*', 1);
  koffi.encode(ptrBuf, 'void*', num);
  // Created with NULL callbacks: the array does not own `num`, so the caller
  // releases both (releaseAll) — main.js's tile reconciler reads Spaces every
  // couple of seconds for every widget, so a leak per call adds up.
  return { arr: fns.CFArrayCreate(null, ptrBuf, 1, null), num };
}

function releaseAll(...refs) {
  for (const ref of refs) {
    if (!ref) continue;
    try { fns.CFRelease(ref); } catch { /* ignore */ }
  }
}

/**
 * @param {import('electron').BrowserWindow} win
 * @returns {number|null} the CGWindowID electron assigned this window, or
 *   null if it can't be determined (window destroyed, non-macOS, etc).
 */
function cgWindowId(win) {
  if (!supported || !win || win.isDestroyed()) return null;
  try {
    // getMediaSourceId() encodes "window:<CGWindowID>:0" on macOS — the only
    // public Electron API that exposes the underlying CGWindowID.
    const match = /^window:(\d+):/.exec(win.getMediaSourceId());
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

/**
 * Reads the macOS Space id64 this window currently sits on.
 * @param {import('electron').BrowserWindow} win
 * @returns {bigint|null}
 */
function getSpaceForWindow(win) {
  if (!supported) return null;
  init();
  if (!fns) return null;
  const wid = cgWindowId(win);
  if (wid == null) return null;
  let ids = null;
  let spacesRet = null;
  try {
    const koffi = require('koffi');
    ids = makeSingleWindowIdArray(koffi, wid);
    spacesRet = fns.CGSCopySpacesForWindows(cid, kCGSAllSpacesMask, ids.arr);
    if (!spacesRet) return null;
    const count = fns.CFArrayGetCount(spacesRet);
    if (count < 1) return null;
    const numPtr = fns.CFArrayGetValueAtIndex(spacesRet, 0);
    const out = Buffer.alloc(8);
    fns.CFNumberGetValue(numPtr, kCFNumberSInt64Type, out);
    return out.readBigUInt64LE(0);
  } catch (err) {
    console.warn('[widget] spaces: getSpaceForWindow failed:', err);
    return null;
  } finally {
    releaseAll(spacesRet, ids && ids.arr, ids && ids.num);
  }
}

/**
 * The Space currently SHOWN on the display this window is on — with
 * "Displays have separate Spaces" every display has its own. A widget is on
 * screen iff getSpaceForWindow(win) equals this. (Read for the tile
 * reconciler in main.js: being on a non-current Space, not merely being
 * covered by another app's window, is what makes a widget grow.)
 * @param {import('electron').BrowserWindow} win
 * @returns {bigint|null}
 */
function getCurrentSpaceForWindow(win) {
  if (!supported) return null;
  init();
  if (!fns) return null;
  const wid = cgWindowId(win);
  if (wid == null) return null;
  let display = null;
  try {
    display = fns.CGSCopyManagedDisplayForWindow(cid, wid);
    if (!display) return null;   // a null CFString would crash the next call
    const space = fns.CGSManagedDisplayGetCurrentSpace(cid, display);
    return space ? BigInt(space) : null;
  } catch (err) {
    console.warn('[widget] spaces: getCurrentSpaceForWindow failed:', err);
    return null;
  } finally {
    if (display) {
      try { fns.CFRelease(display); } catch { /* ignore */ }
    }
  }
}

/**
 * Moves THIS APP'S OWN window to the given macOS Space. Never call this with
 * a window/id belonging to another process — see module doc.
 * @param {import('electron').BrowserWindow} win
 * @param {bigint} spaceId
 */
function moveWindowToSpace(win, spaceId) {
  if (!supported || spaceId == null) return;
  init();
  if (!fns) return;
  const wid = cgWindowId(win);
  if (wid == null) return;
  try {
    const koffi = require('koffi');
    const ids = makeSingleWindowIdArray(koffi, wid);
    fns.CGSMoveWindowsToManagedSpace(cid, ids.arr, spaceId);
    releaseAll(ids.arr, ids.num);
  } catch (err) {
    console.warn('[widget] spaces: moveWindowToSpace failed:', err);
  }
}

/**
 * Where this window's Space sits in its display's left-to-right order (the
 * order Mission Control shows, fullscreen apps included), and where the
 * Space that display is showing sits — so a caller can say "that agent
 * lives to the LEFT of here". Reads CGSCopyManagedDisplaySpaces, the same
 * private SkyLight surface as the rest of this file: one array of display
 * dicts, each with a "Spaces" array of dicts carrying "id64" and a "Current
 * Space" dict. null when anything is unknown (non-macOS, API gone, window
 * not yet on screen, Space not found on any display).
 * @param {import('electron').BrowserWindow} win
 * @returns {{index: number, currentIndex: number, count: number}|null}
 */
function getSpaceOrderForWindow(win) {
  if (!supported) return null;
  init();
  if (!fns) return null;
  const space = getSpaceForWindow(win);
  if (space == null) return null;
  let displays = null;
  const keys = [];
  try {
    displays = fns.CGSCopyManagedDisplaySpaces(cid);
    if (!displays) return null;
    const key = (s) => {
      const k = fns.CFStringCreateWithCString(null, s, kCFStringEncodingUTF8);
      keys.push(k);
      return k;
    };
    const kSpaces = key('Spaces');
    const kCurrent = key('Current Space');
    const kId = key('id64');
    const id64 = (dict) => {
      const p = dict ? fns.CFDictionaryGetValue(dict, kId) : null;
      if (!p) return null;
      const out = Buffer.alloc(8);
      fns.CFNumberGetValue(p, kCFNumberSInt64Type, out);
      return out.readBigUInt64LE(0);
    };
    const nDisplays = fns.CFArrayGetCount(displays);
    for (let d = 0; d < nDisplays; d++) {
      const disp = fns.CFArrayGetValueAtIndex(displays, d);
      const list = fns.CFDictionaryGetValue(disp, kSpaces);
      if (!list) continue;
      const count = fns.CFArrayGetCount(list);
      const ids = [];
      for (let i = 0; i < count; i++) ids.push(id64(fns.CFArrayGetValueAtIndex(list, i)));
      const index = ids.indexOf(space);
      if (index === -1) continue;
      const currentIndex = ids.indexOf(id64(fns.CFDictionaryGetValue(disp, kCurrent)));
      if (currentIndex === -1) return null;
      return { index, currentIndex, count };
    }
    return null;
  } catch (err) {
    console.warn('[widget] spaces: getSpaceOrderForWindow failed:', err);
    return null;
  } finally {
    releaseAll(displays, ...keys);
  }
}

module.exports = { supported, getSpaceForWindow, getCurrentSpaceForWindow, getSpaceOrderForWindow, moveWindowToSpace };
