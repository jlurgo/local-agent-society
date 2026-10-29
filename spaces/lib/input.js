'use strict';
/**
 * Input INTO the Mac from the headset: real mouse, scroll and keyboard
 * events posted to the system (CoreGraphics CGEvent through koffi), aimed
 * at a window by normalized coordinates inside its bounds. The window must
 * be in front on the current Space — the server focuses it when it goes on
 * the stage. Needs Accessibility for the process (its parent app, when run
 * from a terminal). Keys: text is typed as Unicode (any layout), special
 * keys by their virtual key code.
 */
const { dep } = require('./deps');
const koffi = dep('koffi');
const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');

const CGEventCreateMouseEvent = cg.func('void* CGEventCreateMouseEvent(void*, uint32_t, double, double, uint32_t)');
const CGEventCreateScrollWheelEvent = cg.func('void* CGEventCreateScrollWheelEvent(void*, uint32_t, uint32_t, int32_t, int32_t)');
const CGEventCreateKeyboardEvent = cg.func('void* CGEventCreateKeyboardEvent(void*, uint16_t, bool)');
const CGEventKeyboardSetUnicodeString = cg.func('void CGEventKeyboardSetUnicodeString(void*, unsigned long, void*)');
const CGEventSetFlags = cg.func('void CGEventSetFlags(void*, uint64_t)');
const CGEventSetIntegerValueField = cg.func('void CGEventSetIntegerValueField(void*, uint32_t, int64_t)');
const CGEventPost = cg.func('void CGEventPost(uint32_t, void*)');
const CFRelease = cf.func('void CFRelease(void*)');

const kCGHIDEventTap = 0;
const ev = { leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, moved: 5, leftDragged: 6 };
const kCGMouseEventClickState = 1;
const kCGScrollEventUnitPixel = 0;
const flags = { shift: 1 << 17, control: 1 << 18, option: 1 << 19, command: 1 << 20 };
const keyCodes = { enter: 36, return: 36, tab: 48, space: 49, backspace: 51, delete: 51, escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121, forwarddelete: 117, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96 };
const letterCodes = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, 9: 25, 7: 26, 8: 28, 0: 29, o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46 };

const post = (e) => { CGEventPost(kCGHIDEventTap, e); CFRelease(e); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mouseMove(x, y) { post(CGEventCreateMouseEvent(null, ev.moved, x, y, 0)); }
async function click(x, y, { button = 'left', count = 1 } = {}) {
  const down = button === 'right' ? ev.rightDown : ev.leftDown, up = button === 'right' ? ev.rightUp : ev.leftUp, b = button === 'right' ? 1 : 0;
  post(CGEventCreateMouseEvent(null, ev.moved, x, y, 0));
  for (let i = 1; i <= count; i++) {
    const d = CGEventCreateMouseEvent(null, down, x, y, b); CGEventSetIntegerValueField(d, kCGMouseEventClickState, i); post(d);
    const u = CGEventCreateMouseEvent(null, up, x, y, b); CGEventSetIntegerValueField(u, kCGMouseEventClickState, i); post(u);
    if (i < count) await sleep(40);
  }
}
function scroll(x, y, dx, dy) {
  post(CGEventCreateMouseEvent(null, ev.moved, x, y, 0));
  post(CGEventCreateScrollWheelEvent(null, kCGScrollEventUnitPixel, 2, Math.round(-dy), Math.round(-dx)));
}
/** Types text as it is, any characters, through Unicode key events (one event per character). */
async function type(text) {
  for (const ch of String(text)) {
    const buf = Buffer.from(ch, 'utf16le');
    const code = letterCodes[ch.toLowerCase()] ?? 0;
    const d = CGEventCreateKeyboardEvent(null, code, true); CGEventKeyboardSetUnicodeString(d, buf.length / 2, buf); post(d);
    const u = CGEventCreateKeyboardEvent(null, code, false); CGEventKeyboardSetUnicodeString(u, buf.length / 2, buf); post(u);
    await sleep(6);
  }
}
/** A special key (enter, backspace, tab, escape, arrows…) or a letter, with modifiers: ['command','shift',…]. */
function key(name, mods = []) {
  const code = keyCodes[String(name).toLowerCase()] ?? letterCodes[String(name).toLowerCase()];
  if (code === undefined) throw new Error(`unknown key: ${name}`);
  const f = mods.reduce((acc, m) => acc | (flags[m] || 0), 0);
  const d = CGEventCreateKeyboardEvent(null, code, true); if (f) CGEventSetFlags(d, f); post(d);
  const u = CGEventCreateKeyboardEvent(null, code, false); if (f) CGEventSetFlags(u, f); post(u);
}

module.exports = { mouseMove, click, scroll, type, key };
