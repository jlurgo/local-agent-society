#!/usr/bin/env node
'use strict';
/**
 * las-spaces — phase 0: serves the headset app (spaces/xr) and takes its
 * reports. Reached from the Quest as http://localhost:PORT over the USB
 * tunnel (`adb reverse tcp:PORT tcp:PORT`): a secure context for WebXR
 * without certificates. The port comes from the LAS registry
 * (`las ports claim las-spaces`). See docs/plans/2026-10-29-quest-spaces.md.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.LAS_SPACES_PORT || process.argv[2] || 9002);
const XR_DIR = path.join(__dirname, 'xr');
const LOG_PATH = path.join(__dirname, '..', 'session', 'spaces.log');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

function log(component, message) {
  const line = `[${new Date().toISOString()}] INFO  [${component}] ${message}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_PATH, line); } catch { /* best effort */ }
}

const server = http.createServer((req, res) => {
  log('http', `${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  if (req.method === 'POST' && req.url === '/hello') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      log('hello', body.replace(/\s+/g, ' ').slice(0, 1000));
      res.writeHead(204).end();
    });
    return;
  }
  const rel = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = path.normalize(path.join(XR_DIR, rel));
  if (!file.startsWith(XR_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

// Minimal WebSocket (RFC 6455, text frames, no deps): the headset keeps one
// open from page load; phase 0 uses it to learn whether a socket opened
// BEFORE entering VR keeps working inside the immersive session (fetch did
// not, 2026-10-29).
const crypto = require('node:crypto');
server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  log('ws', `open from ${socket.remoteAddress}`);
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
      if (op === 8) { log('ws', 'close'); socket.end(); return; }
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 1 && fin) log('ws', payload.toString('utf8').replace(/\s+/g, ' ').slice(0, 1000));
    }
  });
  socket.on('error', (e) => log('ws', `error ${e.message}`));
  socket.on('close', () => log('ws', 'closed'));
});

server.listen(PORT, '127.0.0.1', () => log('server', `las-spaces phase 0 listening on http://127.0.0.1:${PORT} (xr dir ${XR_DIR})`));
