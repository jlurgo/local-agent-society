'use strict';
// Native deps (koffi, sharp) come from spaces/node_modules when installed
// there, else from the widget app's node_modules next door — same checkout,
// same versions — so phase 1 runs with no install step of its own.
const path = require('node:path');
function dep(name) {
  try { return require(name); } catch { /* fall through */ }
  return require(path.join(__dirname, '..', '..', 'widget-electron', 'node_modules', name));
}
module.exports = { dep };
