'use strict';
/**
 * Terminals as TEXT, not pixels: Terminal.app hands over every window's
 * visible screen through AppleScript (`contents of selected tab`), plus its
 * size in rows and columns. One osascript call reads ALL windows at once
 * (~0.3–1 s, mostly process start), so the server polls once a second while
 * someone is watching and pushes only what changed. Matched to the world's
 * windows by window name (the CG window title). Later: tmux-backed sessions
 * for colours (docs/plans/2026-10-29-quest-spaces.md).
 */
const { execFile } = require('node:child_process');

const SEP_WIN = '\u0001', SEP_FIELD = '\u0002';
// By index, with full object specifiers: `contents of <variable>` is read by
// AppleScript as its own dereference operator and yields the tab object, not
// the tab's text (seen: "Can't make «class ttab» into Unicode text").
const SCRIPT = `
tell application "Terminal"
  set out to ""
  repeat with i from 1 to (count of windows)
    try
      set out to out & (ASCII character 1) & (name of window i) & (ASCII character 2) & (number of rows of selected tab of window i) & (ASCII character 2) & (number of columns of selected tab of window i) & (ASCII character 2) & (contents of selected tab of window i)
    end try
  end repeat
  return out
end tell`;

/** @returns {Promise<Array<{name: string, rows: number, cols: number, text: string}>>} */
function readTerminals() {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', SCRIPT], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const out = [];
      for (const chunk of String(stdout).split(SEP_WIN)) {
        if (!chunk) continue;
        const [name, rows, cols, ...rest] = chunk.split(SEP_FIELD);
        const text = rest.join(SEP_FIELD).replace(/\n$/, '');
        if (name) out.push({ name, rows: Number(rows) || 0, cols: Number(cols) || 0, text });
      }
      resolve(out);
    });
  });
}

module.exports = { readTerminals };
