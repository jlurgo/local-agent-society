#!/usr/bin/env node
/**
 * las-bridge <sink> [--agent NAME] [options]
 *
 * Deliver an agent's vortexia mailbox into a session runtime:
 *   claude   Claude Code channel (this process is the MCP server; start it
 *            from ~/.claude.json's mcpServers, see `las claude register`)
 *   stdout   one JSON line per message (what `las agent listen` printed)
 *   shell    a plain terminal: print every message, offer kind="command"
 *            ones to run here (--yes to skip the prompt, --all for any text)
 *   exec     run --exec CMD per message with the text on stdin (Codex, a
 *            local model, any tool) and send its output back to the sender
 *
 * Common: --agent NAME (default: nearest .las-agent.json), --runtime NAME (what
 * `las agent sessions` shows; default = the sink), --intercept-url URL
 * (first-decision hook, fails open), --port N (broker), --quiet.
 */
import { parseArgs } from 'node:util';
import { idleClaudeServer } from '../src/sinks/claude-channel.js';
import {
  Bridge, MailboxSource, Pipeline, dedupInterceptor, ignoreKindsInterceptor, senderPolicyInterceptor,
  micSelfTestInterceptor, httpInterceptor, ClaudeChannelSink, StdoutSink, ShellSink, ExecSink,
  KIND, resolveAgent, StatusFile, makeSender,
} from '../src/index.js';
import { SessionRegistry, DefaultWatcher, newSessionId, sessionInboxTopic, sessionMailboxClientId } from '../src/sessions.js';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: 'string' },
    port: { type: 'string' },
    'intercept-url': { type: 'string' },
    exec: { type: 'string' },
    runtime: { type: 'string' },
    yes: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const SINKS = ['claude', 'stdout', 'shell', 'exec'];
const sinkName = positionals[0];
if (opts.help || !SINKS.includes(sinkName)) {
  process.stderr.write(`usage: las-bridge <${SINKS.join('|')}> [--agent NAME] [--exec CMD] [--runtime NAME] [--yes] [--all] [--intercept-url URL] [--port N] [--quiet]\n`);
  process.exit(opts.help ? 0 : 64);
}

// stdout is the MCP wire for the claude sink and the data stream for stdout
// — every human-facing line goes to stderr, always.
const log = opts.quiet ? () => {} : (msg) => process.stderr.write(`[las-bridge] ${msg}\n`);

let agent;
try {
  agent = resolveAgent({ name: opts.agent });
} catch (err) {
  if (sinkName === 'claude') {
    // Registered user-level, this server is spawned for EVERY Claude session,
    // including ones outside any agent folder. There, stay connected as an
    // empty server instead of dying: a dead MCP server shows up as a red
    // "failed" line in every unrelated project, and there is nothing to
    // deliver anyway.
    log(`no LAS agent here (${err.message}) — idle, delivering nothing`);
    await idleClaudeServer();
    process.exit(0);
  }
  process.stderr.write(`las-bridge: ${err.message}\n`);
  process.exit(64);
}

const send = makeSender({ from: agent.name });
const source = new MailboxSource({ agent: agent.name, port: opts.port, log });
const interceptors = [
  dedupInterceptor(),
  // A kind=cc copy is for the record: only the Claude channel can carry it
  // as such (the kind attribute + its instructions). Typed into Codex or
  // handed to a shell/exec it would be acted on, so those never see it.
  ignoreKindsInterceptor([KIND.MIC_SELFTEST_PONG, KIND.PROBE, ...(sinkName === 'claude' ? [] : [KIND.CC])]),
  senderPolicyInterceptor({ log }),
  micSelfTestInterceptor({ agent: agent.name }),
];
if (opts['intercept-url']) interceptors.push(httpInterceptor({ url: opts['intercept-url'], log }));

let sink;
switch (sinkName) {
  case 'claude':
    sink = new ClaudeChannelSink({ agent: agent.name, send, log });
    break;
  case 'stdout':
    sink = new StdoutSink();
    break;
  case 'shell':
    // Where you launched it, not the agent's root: same as running the shell yourself.
    sink = new ShellSink({ cwd: process.cwd(), confirm: !opts.yes, all: opts.all });
    break;
  case 'exec':
    if (!opts.exec) {
      process.stderr.write('las-bridge exec: --exec CMD is required\n');
      process.exit(64);
    }
    sink = new ExecSink({ command: opts.exec, cwd: process.cwd() });
    break;
}

// This process is one SESSION of the agent (docs/adr/0004 phase 2): it has
// its own inbox, and holds the agent-level one only while it is the default.
const runtime = opts.runtime || (sinkName === 'exec' ? (opts.exec.trim().split(/\s+/)[0] === 'codex' ? 'codex' : 'exec') : sinkName === 'claude' ? 'claude' : sinkName);
const sid = newSessionId(runtime);
const session = new SessionRegistry({ agent: agent.name, sid, runtime, cwd: process.cwd(), log });
const sessionSource = new MailboxSource({ agent: agent.name, topic: sessionInboxTopic(agent.name, sid), clientId: sessionMailboxClientId(agent.name, sid), port: opts.port, log });
const defaultWatcher = new DefaultWatcher({ agent: agent.name, port: opts.port, log });
const status = new StatusFile({ agent: agent.name, sink: sink.name, sid });
const bridge = new Bridge({ agent: agent.name, source, pipeline: new Pipeline(interceptors), sink, send, status, log, session, sessionSource, defaultWatcher });

let exiting = false;
async function shutdown(code) {
  if (exiting) return;
  exiting = true;
  try {
    await bridge.stop();
  } finally {
    process.exit(code);
  }
}

source.on('connect', ({ sessionPresent, port }) => log(`${agent.name}: mailbox attached on :${port} (${sessionPresent ? 'session resumed' : 'new session'})`));
source.on('takeover', () => shutdown(2));
sessionSource.on('takeover', () => shutdown(2));
if (sink instanceof ClaudeChannelSink) {
  sink.onclose = () => shutdown(0);
  // Claude Code exiting closes our stdin; the SDK's stdio transport does not
  // turn that into onclose by itself, and the MQTT connection would keep this
  // process alive — a zombie holding the mailbox. Stdin end == parent gone.
  process.stdin.once('end', () => shutdown(0));
  process.stdin.once('close', () => shutdown(0));
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

bridge.run().catch((err) => {
  process.stderr.write(`las-bridge: ${err && err.stack ? err.stack : err}\n`);
  shutdown(1);
});
