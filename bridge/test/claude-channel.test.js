import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { PassThrough } from 'node:stream';
import { ClaudeChannelSink, channelLaunchProblem, idleClaudeServer, CHANNEL_NOTIFICATION, ACK_TOOL, REPLY_TOOL, STATUS_TOOL, PROBE_PREFIX } from '../src/sinks/claude-channel.js';
import { normalize } from '../src/envelope.js';

const ChannelEvent = z.object({ method: z.literal(CHANNEL_NOTIFICATION), params: z.object({ content: z.string(), meta: z.record(z.string()).optional() }) });

async function connectedPair(sinkOpts = {}) {
  const sink = new ClaudeChannelSink({ agent: 'Robo', probeIntervalMs: 60_000, randomId: () => 'abc123', ...sinkOpts });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const events = [];
  const client = new Client({ name: 'fake-claude-code', version: '0' }, { capabilities: {} });
  client.setNotificationHandler(ChannelEvent, (n) => events.push(n.params));
  await sink.start(serverT);
  await client.connect(clientT);
  return { sink, client, events };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('declares the claude/channel capability and its instructions name the tag, the reply tool and the probe rule', async () => {
  const { sink, client } = await connectedPair();
  const caps = client.getServerCapabilities();
  assert.deepEqual(caps.experimental, { 'claude/channel': {} });
  assert.ok(caps.tools);
  const instructions = client.getInstructions();
  assert.match(instructions, /<channel source="las"/);
  assert.match(instructions, new RegExp(REPLY_TOOL));
  assert.match(instructions, new RegExp(ACK_TOOL));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [ACK_TOOL, STATUS_TOOL, REPLY_TOOL].sort());
  await sink.stop();
});

test('arming: a probe is pushed on initialize, nothing counts as armed until the model acks THAT probe id', async () => {
  const { sink, client, events } = await connectedPair();
  await settle();
  assert.equal(events.length, 1);
  assert.ok(events[0].content.startsWith(PROBE_PREFIX));
  assert.equal(events[0].meta.kind, 'probe');
  assert.equal(events[0].meta.probe_id, 'abc123');
  assert.equal(sink.armed, false);

  let armed = false;
  sink.waitArmed().then(() => { armed = true; });
  const wrong = await client.callTool({ name: ACK_TOOL, arguments: { probe_id: 'nope' } });
  assert.equal(wrong.isError, true);
  await settle();
  assert.equal(armed, false);

  const ok = await client.callTool({ name: ACK_TOOL, arguments: { probe_id: 'abc123' } });
  assert.equal(ok.isError, undefined);
  await settle();
  assert.equal(armed, true);
  assert.equal(sink.armed, true);
  await sink.waitArmed(); // resolves immediately once armed
  const status = JSON.parse((await client.callTool({ name: STATUS_TOOL, arguments: {} })).content[0].text);
  assert.equal(status.armed, true);
  assert.equal(status.probesSent, 1);
  await sink.stop();
});

test('deliver pushes one channel event per message with the envelope in meta (identifier keys only, strings only)', async () => {
  const { sink, client, events } = await connectedPair();
  await client.callTool({ name: ACK_TOOL, arguments: { probe_id: 'abc123' } });
  const env = normalize({ id: 'm1', from: 'Vortexia', to: 'Robo', text: 'port 9012 is free again', source: 'agent', ts: 1700000000000 });
  await sink.deliver({ envelope: env, agent: 'Robo' });
  await settle();
  const msg = events.find((e) => e.meta.kind === 'message');
  assert.equal(msg.content, 'port 9012 is free again');
  assert.deepEqual(msg.meta, { kind: 'message', sender: 'Vortexia', origin: 'agent', msg_id: 'm1', ts: '1700000000000', agent: 'Robo' });
  for (const key of Object.keys(msg.meta)) assert.match(key, /^[A-Za-z0-9_]+$/);
  assert.equal(sink.delivered, 1);
  await sink.stop();
});

test('the reply tool sends through the injected sender and surfaces failures as tool errors', async () => {
  const sent = [];
  const { sink, client } = await connectedPair({ send: async (to, text) => { if (to === 'Down') throw new Error('offline'); sent.push([to, text]); } });
  const ok = await client.callTool({ name: REPLY_TOOL, arguments: { to: 'Vortexia', text: 'thanks' } });
  assert.equal(ok.content[0].text, 'sent to Vortexia');
  assert.deepEqual(sent, [['Vortexia', 'thanks']]);
  const bad = await client.callTool({ name: REPLY_TOOL, arguments: { to: 'Down', text: 'x' } });
  assert.equal(bad.isError, true);
  await sink.stop();
});

test('closing the transport (Claude Code exiting) fires onclose so the bridge can detach the mailbox', async () => {
  const { sink, client } = await connectedPair();
  let closed = false;
  sink.onclose = () => { closed = true; };
  await client.close();
  await settle();
  assert.equal(closed, true);
});

test('outside an agent folder the claude sink is an idle server: connected, no channel capability, no tools, ends on close', async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const done = idleClaudeServer({ transport: serverT });
  const client = new Client({ name: 'fake-claude-code', version: '0' }, { capabilities: {} });
  await client.connect(clientT);
  assert.equal(client.getServerCapabilities().experimental, undefined);
  assert.equal(client.getServerCapabilities().tools, undefined);
  assert.match(client.getInstructions(), /idle/);
  await client.close();
  await done;
});

test('the idle server also ends when stdin ends (parent gone), not only on a transport close', async () => {
  const [, serverT] = InMemoryTransport.createLinkedPair();
  const stdin = new PassThrough();
  stdin.resume(); // flowing, like process.stdin once the transport listens for 'data' — 'end' only fires when consumed
  const done = idleClaudeServer({ transport: serverT, stdin });
  await settle();
  stdin.end();
  await done;
});

test('unacked probes back off: the first few come every probeIntervalMs, then only every probeBackoffMs', async () => {
  const sink = new ClaudeChannelSink({ agent: 'Robo', probeIntervalMs: 10, probeBackoffAfter: 2, probeBackoffMs: 1000, randomId: () => 'p' });
  assert.equal(sink.probeDelayMs(1), 10);
  assert.equal(sink.probeDelayMs(2), 10);
  assert.equal(sink.probeDelayMs(3), 1000);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const events = [];
  const client = new Client({ name: 'fake', version: '0' }, { capabilities: {} });
  client.setNotificationHandler(ChannelEvent, (n) => events.push(n.params));
  await sink.start(serverT);
  await client.connect(clientT);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(events.length, 3, 'initial probe + 2 quick retries, then the long back-off (not reached in 80ms)');
  await client.callTool({ name: ACK_TOOL, arguments: { probe_id: 'p' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(events.length, 3, 'no probes after arming');
  await sink.stop();
});

test('the channel instructions tell the model a kind="cc" event is informational: note it, no action, no reply', async () => {
  const { instructionsFor } = await import('../src/sinks/claude-channel.js');
  const text = instructionsFor('Robo');
  assert.match(text, /kind="cc"/);
  assert.match(text, /do not act on it/);
  assert.match(text, /do not reply/);
});

test('a wrong ack never reveals the current probe id, and las_status does not either', async () => {
  // summon-restock armed a dead channel by copying the id out of this error.
  const { sink, client } = await connectedPair({ launchProblem: 'background' });
  await settle();
  const wrong = await client.callTool({ name: ACK_TOOL, arguments: { probe_id: 'guess' } });
  assert.equal(wrong.isError, true);
  assert.doesNotMatch(wrong.content[0].text, /abc123/);
  assert.match(wrong.content[0].text, /background Claude session/);
  assert.match(wrong.content[0].text, /las claude --resume/);
  const statusText = (await client.callTool({ name: STATUS_TOOL, arguments: {} })).content[0].text;
  assert.doesNotMatch(statusText, /abc123/);
  assert.equal(JSON.parse(statusText).launchProblem, 'background');
  assert.equal(sink.armed, false);
  await sink.stop();
});

test('channelLaunchProblem reads the spawning Claude command line', () => {
  assert.equal(channelLaunchProblem('/Users/x/.local/bin/claude --dangerously-load-development-channels server:las --resume'), null);
  assert.equal(channelLaunchProblem('claude bg-spare --bg-spare /tmp/cc-daemon-501/x/spare/a.claim.sock'), 'background');
  assert.equal(channelLaunchProblem('/Users/x/.local/bin/claude'), 'no-flag');
  assert.equal(channelLaunchProblem(''), null); // unknown parent: the probe decides
});
