'use strict';
/**
 * The Mac's windows and Spaces, from plain Node through koffi — the same
 * CoreGraphics/CoreFoundation/SkyLight surface widget-electron/lib/spaces.js
 * uses, extended to EVERY window on EVERY Space:
 *   listWindows()        every normal window: id, pid, app, title, bounds, onScreen
 *   spaceOfWindow(wid)   the Space a window sits on (CGS, private)
 *   displaySpaces()      per display: its Spaces in Mission Control order + the current one
 *   captureWindow(wid)   the window's pixels, from any Space, as a JPEG (sharp)
 * Verified 2026-10-29 (macOS 14.5): off-Space windows capture with real
 * pixels; CGWindowListCreateImage is deprecated but works — ScreenCaptureKit
 * is the later swap. Needs Screen Recording for the process's parent app.
 */
const { dep } = require('./deps');
const koffi = dep('koffi');

const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
const sl = koffi.load('/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight');

const CGWindowListCopyWindowInfo = cg.func('void* CGWindowListCopyWindowInfo(uint32_t, uint32_t)');
const CGWindowListCreateImage = cg.func('void* CGWindowListCreateImage(double, double, double, double, uint32_t, uint32_t, uint32_t)');
const CGImageGetWidth = cg.func('size_t CGImageGetWidth(void*)');
const CGImageGetHeight = cg.func('size_t CGImageGetHeight(void*)');
const CGImageGetBytesPerRow = cg.func('size_t CGImageGetBytesPerRow(void*)');
const CGImageGetDataProvider = cg.func('void* CGImageGetDataProvider(void*)');
const CGDataProviderCopyData = cg.func('void* CGDataProviderCopyData(void*)');
const CFDataGetBytePtr = cf.func('void* CFDataGetBytePtr(void*)');
const CFDataGetLength = cf.func('long CFDataGetLength(void*)');
const CFArrayGetCount = cf.func('long CFArrayGetCount(void*)');
const CFArrayGetValueAtIndex = cf.func('void* CFArrayGetValueAtIndex(void*, long)');
const CFArrayCreate = cf.func('void* CFArrayCreate(void*, void**, long, void*)');
const CFDictionaryGetValue = cf.func('void* CFDictionaryGetValue(void*, void*)');
const CFStringCreateWithCString = cf.func('void* CFStringCreateWithCString(void*, const char*, unsigned int)');
const CFStringGetCString = cf.func('bool CFStringGetCString(void*, char*, long, unsigned int)');
const CFNumberCreate = cf.func('void* CFNumberCreate(void*, int, void*)');
const CFNumberGetValue = cf.func('bool CFNumberGetValue(void*, int, void*)');
const CFBooleanGetValue = cf.func('bool CFBooleanGetValue(void*)');
const CFRelease = cf.func('void CFRelease(void*)');
const CGSMainConnectionID = sl.func('unsigned int CGSMainConnectionID()');
const CGSCopySpacesForWindows = sl.func('void* CGSCopySpacesForWindows(unsigned int, int, void*)');
const CGSCopyManagedDisplaySpaces = sl.func('void* CGSCopyManagedDisplaySpaces(unsigned int)');

const kCFStringEncodingUTF8 = 0x08000100;
const kCFNumberSInt32Type = 3, kCFNumberSInt64Type = 4, kCFNumberDoubleType = 13;
const kCGWindowListOptionAll = 0;
const kCGWindowListOptionIncludingWindow = 1 << 3;
const kCGWindowImageBoundsIgnoreFraming = 1 << 0;
const kCGWindowImageNominalResolution = 1 << 4;   // 1x, not Retina 2x: half the bytes, text still legible
const kCGSAllSpacesMask = 7;

const cid = CGSMainConnectionID();
const keys = {};
const key = (s) => (keys[s] ||= CFStringCreateWithCString(null, s, kCFStringEncodingUTF8));
const str = (p) => { if (!p) return ''; const b = Buffer.alloc(1024); return CFStringGetCString(p, b, b.length, kCFStringEncodingUTF8) ? b.toString('utf8').replace(/\0.*$/s, '') : ''; };
const i32 = (p) => { if (!p) return null; const b = Buffer.alloc(8); CFNumberGetValue(p, kCFNumberSInt32Type, b); return b.readInt32LE(0); };
const i64 = (p) => { if (!p) return null; const b = Buffer.alloc(8); CFNumberGetValue(p, kCFNumberSInt64Type, b); return b.readBigUInt64LE(0).toString(); };
const f64 = (p) => { if (!p) return null; const b = Buffer.alloc(8); CFNumberGetValue(p, kCFNumberDoubleType, b); return b.readDoubleLE(0); };
const bool = (p) => (p ? Boolean(CFBooleanGetValue(p)) : false);

/** Every layer-0 (normal) window the window server knows, any Space. */
function listWindows() {
  const list = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, 0);
  const out = [];
  try {
    const n = CFArrayGetCount(list);
    for (let i = 0; i < n; i++) {
      const w = CFArrayGetValueAtIndex(list, i);
      if (i32(CFDictionaryGetValue(w, key('kCGWindowLayer'))) !== 0) continue;
      const b = CFDictionaryGetValue(w, key('kCGWindowBounds'));
      const bounds = b ? { x: f64(CFDictionaryGetValue(b, key('X'))), y: f64(CFDictionaryGetValue(b, key('Y'))), width: f64(CFDictionaryGetValue(b, key('Width'))), height: f64(CFDictionaryGetValue(b, key('Height'))) } : null;
      if (!bounds || bounds.width < 50 || bounds.height < 50) continue;
      out.push({
        wid: i32(CFDictionaryGetValue(w, key('kCGWindowNumber'))),
        pid: i32(CFDictionaryGetValue(w, key('kCGWindowOwnerPID'))),
        app: str(CFDictionaryGetValue(w, key('kCGWindowOwnerName'))),
        title: str(CFDictionaryGetValue(w, key('kCGWindowName'))),
        bounds,
        onScreen: bool(CFDictionaryGetValue(w, key('kCGWindowIsOnscreen'))),
        z: i,   // CG lists front to back
      });
    }
  } finally {
    CFRelease(list);
  }
  return out;
}

/** The Space id (as a decimal string) a window sits on, or null. */
function spaceOfWindow(wid) {
  const nb = Buffer.alloc(4); nb.writeInt32LE(wid, 0);
  const num = CFNumberCreate(null, kCFNumberSInt32Type, nb);
  const pb = koffi.alloc('void*', 1); koffi.encode(pb, 'void*', num);
  const arr = CFArrayCreate(null, pb, 1, null);
  let spaces = null;
  try {
    spaces = CGSCopySpacesForWindows(cid, kCGSAllSpacesMask, arr);
    return spaces && CFArrayGetCount(spaces) ? i64(CFArrayGetValueAtIndex(spaces, 0)) : null;
  } finally {
    for (const r of [spaces, arr, num]) if (r) CFRelease(r);
  }
}

/** Per display: Spaces in Mission Control order (ids as strings) and the current one. */
function displaySpaces() {
  const displays = CGSCopyManagedDisplaySpaces(cid);
  const out = [];
  try {
    const n = CFArrayGetCount(displays);
    for (let d = 0; d < n; d++) {
      const disp = CFArrayGetValueAtIndex(displays, d);
      const list = CFDictionaryGetValue(disp, key('Spaces'));
      const spaces = [];
      const m = list ? CFArrayGetCount(list) : 0;
      for (let i = 0; i < m; i++) {
        const sp = CFArrayGetValueAtIndex(list, i);
        spaces.push({ id: i64(CFDictionaryGetValue(sp, key('id64'))), type: i32(CFDictionaryGetValue(sp, key('type'))) });
      }
      const cur = CFDictionaryGetValue(disp, key('Current Space'));
      out.push({ display: str(CFDictionaryGetValue(disp, key('Display Identifier'))), spaces, current: cur ? i64(CFDictionaryGetValue(cur, key('id64'))) : null });
    }
  } finally {
    CFRelease(displays);
  }
  return out;
}

// ── native scale + JPEG: CoreGraphics draws the capture into a smaller bitmap
// context, ImageIO encodes it — no pixel loop in JS, no sharp. The sharp path
// below stays as the fallback.
const io = koffi.load('/System/Library/Frameworks/ImageIO.framework/ImageIO');
const CGColorSpaceCreateDeviceRGB = cg.func('void* CGColorSpaceCreateDeviceRGB()');
const CGBitmapContextCreate = cg.func('void* CGBitmapContextCreate(void*, size_t, size_t, size_t, size_t, void*, uint32_t)');
const CGContextSetInterpolationQuality = cg.func('void CGContextSetInterpolationQuality(void*, int)');
const CGContextDrawImage = cg.func('void CGContextDrawImage(void*, double, double, double, double, void*)');
const CGBitmapContextCreateImage = cg.func('void* CGBitmapContextCreateImage(void*)');
const CGContextRelease = cg.func('void CGContextRelease(void*)');
const CFDataCreateMutable = cf.func('void* CFDataCreateMutable(void*, long)');
const CGImageDestinationCreateWithData = io.func('void* CGImageDestinationCreateWithData(void*, void*, size_t, void*)');
const CGImageDestinationAddImage = io.func('void CGImageDestinationAddImage(void*, void*, void*)');
const CGImageDestinationFinalize = io.func('bool CGImageDestinationFinalize(void*)');
const CFDictionaryCreate = cf.func('void* CFDictionaryCreate(void*, void**, void**, long, void*, void*)');
const kCGBitmapInfoBGRA = 6 | (2 << 12);   // kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little
const kCGInterpolationMedium = 2;
let rgbSpace = null;
let jpegProps = null;   // { kCGImageDestinationLossyCompressionQuality: 0.72 }
function jpegProperties() {
  if (jpegProps) return jpegProps;
  try {
    const kq = key('kCGImageDestinationLossyCompressionQuality');
    const qb = Buffer.alloc(8); qb.writeDoubleLE(0.72, 0);
    const q = CFNumberCreate(null, kCFNumberDoubleType, qb);
    const ks = koffi.alloc('void*', 1); koffi.encode(ks, 'void*', kq);
    const vs = koffi.alloc('void*', 1); koffi.encode(vs, 'void*', q);
    // CFType callbacks: the exported globals kCFTypeDictionary{Key,Value}CallBacks
    const kcb = cf.symbol('kCFTypeDictionaryKeyCallBacks', 'void'), vcb = cf.symbol('kCFTypeDictionaryValueCallBacks', 'void');
    jpegProps = CFDictionaryCreate(null, ks, vs, 1, kcb, vcb);
  } catch (err) {
    jpegProps = null;   // ImageIO's default quality then
  }
  return jpegProps;
}

/** Scale a CGImage to at most maxWidth and encode it as JPEG, all in CoreGraphics/ImageIO. */
function scaleAndEncode(img, width, height, maxWidth) {
  const outW = Math.min(maxWidth, width), outH = Math.max(1, Math.round(height * outW / width));
  rgbSpace ||= CGColorSpaceCreateDeviceRGB();
  const ctx = CGBitmapContextCreate(null, outW, outH, 8, outW * 4, rgbSpace, kCGBitmapInfoBGRA);
  if (!ctx) throw new Error('CGBitmapContextCreate failed');
  let scaled = null, data = null, dest = null;
  try {
    CGContextSetInterpolationQuality(ctx, kCGInterpolationMedium);
    CGContextDrawImage(ctx, 0, 0, outW, outH, img);
    scaled = CGBitmapContextCreateImage(ctx);
    data = CFDataCreateMutable(null, 0);
    dest = CGImageDestinationCreateWithData(data, key('public.jpeg'), 1, null);
    if (!dest) throw new Error('CGImageDestinationCreateWithData failed');
    CGImageDestinationAddImage(dest, scaled, jpegProperties());
    if (!CGImageDestinationFinalize(dest)) throw new Error('CGImageDestinationFinalize failed');
    const len = Number(CFDataGetLength(data));
    const jpeg = Buffer.from(koffi.decode(CFDataGetBytePtr(data), 'uint8_t', len));
    return { jpeg, width: outW, height: outH };
  } finally {
    for (const r of [dest, data, scaled]) if (r) CFRelease(r);
    CGContextRelease(ctx);
  }
}

/**
 * The window's pixels as a JPEG, from whichever Space it is on.
 * @returns {Promise<{jpeg: Buffer, width: number, height: number, srcWidth: number, srcHeight: number}|null>}
 */
async function captureWindow(wid, { maxWidth = 480, quality = 70, hi = false } = {}) {
  // hi: the window's full Retina pixels (2x) — for a big view where 1x text is too soft to read; costs ~4x the capture
  const img = CGWindowListCreateImage(Infinity, Infinity, 0, 0, kCGWindowListOptionIncludingWindow, wid, kCGWindowImageBoundsIgnoreFraming | (hi ? 0 : kCGWindowImageNominalResolution));
  if (!img) return null;
  let data = null;
  try {
    const width = Number(CGImageGetWidth(img)), height = Number(CGImageGetHeight(img)), bpr = Number(CGImageGetBytesPerRow(img));
    if (!width || !height) return null;
    if (!process.env.LAS_SPACES_SHARP) {
      try {
        const r = scaleAndEncode(img, width, height, maxWidth);
        return { ...r, srcWidth: width, srcHeight: height };
      } catch (err) {
        if (!scaleAndEncode.warned) { scaleAndEncode.warned = true; console.warn('[spaces] native JPEG path failed, using sharp:', err.message); }
      }
    }
    data = CGDataProviderCopyData(CGImageGetDataProvider(img));
    const len = Number(CFDataGetLength(data));
    const bytes = koffi.decode(CFDataGetBytePtr(data), 'uint8_t', len);
    // Tight RGBA rows out of CG's BGRA with padded rows.
    const rgba = Buffer.alloc(width * height * 4);
    const out32 = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
    for (let r = 0; r < height; r++) {
      const row = new Uint32Array(bytes.buffer, bytes.byteOffset + r * bpr, width);   // little-endian: 0xAARRGGBB
      const o = r * width;
      for (let c = 0; c < width; c++) {
        const px = row[c];
        out32[o + c] = 0xff000000 | ((px & 0xff) << 16) | (px & 0xff00) | ((px >>> 16) & 0xff);   // → 0xAABBGGRR = RGBA bytes
      }
    }
    const sharp = dep('sharp');
    const out = await sharp(rgba, { raw: { width, height, channels: 4 } }).resize({ width: Math.min(maxWidth, width), withoutEnlargement: true }).jpeg({ quality }).toBuffer({ resolveWithObject: true });
    return { jpeg: out.data, width: out.info.width, height: out.info.height, srcWidth: width, srcHeight: height };
  } finally {
    if (data) CFRelease(data);
    CFRelease(img);
  }
}

module.exports = { listWindows, spaceOfWindow, displaySpaces, captureWindow };
