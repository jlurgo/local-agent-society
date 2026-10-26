/**
 * Envelope helpers — the vortexia message shape (vortexia/PROTOCOL.md
 * "Message envelope") plus the kinds the bridge itself cares about.
 *
 * Pure functions only: no I/O, so every sink and interceptor can rely on
 * the same normalization without dragging a broker into their tests.
 */

export const KIND = Object.freeze({
  MESSAGE: 'message',
  COMMAND: 'command',
  SPEAK: 'speak',
  MIC_SELFTEST: 'mic-selftest',
  MIC_SELFTEST_PONG: 'mic-selftest-pong',
  PROBE: 'probe',
  // A for-the-record copy handed to the agent's default session of a message
  // that went to another of its sessions (backend _route_send, docs/adr/0005).
  // Informational: shown, never acted on, never replied to.
  CC: 'cc',
  // The widget asking this one session to title itself (backend
  // request_session_titles). Answered with `las agent title`; not activity,
  // so it never makes the session the default.
  TITLE_REQUEST: 'title-request',
});

export const SOURCE = Object.freeze({ HUMAN: 'human', AGENT: 'agent', SYSTEM: 'system' });

/**
 * Must match widget.js's MIC_SELFTEST_PING and cli/commands/agents.py's copy
 * exactly — there is no shared module between the renderer, the Python CLI
 * and this package, so this is a deliberate literal duplication.
 */
export const MIC_SELFTEST_PING = '[las-mic-selftest] reply with just "OK" to confirm this session is listening.';

/**
 * Return a copy of `raw` with the fields every consumer can count on:
 * `kind` (defaulting per the protocol: "message", or "mic-selftest" when the
 * text is the sentinel), `ts`, `id`, and string `from`/`to`/`text`.
 */
export function normalize(raw, { now = Date.now } = {}) {
  const env = { ...(raw || {}) };
  env.from = typeof env.from === 'string' ? env.from : '?';
  // Crossed vortex-relay: say which Mac it came from, so the sender reads
  // (and a reply goes) as `Name@env` — a bare `System` from another Mac's
  // System looked like this agent talking to itself.
  if (typeof env.routedFrom === 'string' && env.routedFrom && env.from !== '?' && !env.from.includes('@')) {
    env.from = `${env.from}@${env.routedFrom}`;
  }
  env.to = typeof env.to === 'string' ? env.to : '';
  env.text = typeof env.text === 'string' ? env.text : env.text == null ? '' : String(env.text);
  env.source = typeof env.source === 'string' ? env.source : SOURCE.AGENT;
  env.ts = typeof env.ts === 'number' ? env.ts : now();
  if (typeof env.id !== 'string' || !env.id) env.id = `${env.from}:${env.ts}:${env.text.length}`;
  if (typeof env.kind !== 'string' || !env.kind) {
    env.kind = env.text === MIC_SELFTEST_PING ? KIND.MIC_SELFTEST : KIND.MESSAGE;
  }
  return env;
}

export function isMicSelfTest(env) {
  return env.kind === KIND.MIC_SELFTEST || env.text === MIC_SELFTEST_PING;
}

/** The silent "plumbing is alive" answer to the mic self-test. */
export function micSelfTestPong(agent, { now = Date.now } = {}) {
  return { from: agent, to: agent, source: SOURCE.SYSTEM, kind: KIND.MIC_SELFTEST_PONG, text: 'OK', ts: now() };
}
