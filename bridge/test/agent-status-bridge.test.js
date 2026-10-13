import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAgent, findAgentConfig } from '../src/agent.js';
import { StatusFile, readStatus, statusPath } from '../src/status.js';
import { Bridge } from '../src/bridge.js';
import { Pipeline, HANDLED } from '../src/pipeline.js';
import { resolveMqttPort } from '../src/port.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'las-bridge-'));

test('resolveAgent walks up to the nearest .las-agent.json (the retired .agent.json is never read); explicit name wins', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.las-agent.json'), JSON.stringify({ name: 'Parent' }));
  const sub = path.join(root, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(findAgentConfig(sub), path.join(root, '.las-agent.json'));
  assert.deepEqual({ name: resolveAgent({ cwd: sub }).name, dir: resolveAgent({ cwd: sub }).dir }, { name: 'Parent', dir: root });
  assert.equal(resolveAgent({ cwd: sub, name: 'Other' }).name, 'Other');
  const legacy = tmp();
  fs.writeFileSync(path.join(legacy, '.agent.json'), JSON.stringify({ name: 'Old' }));
  assert.equal(findAgentConfig(legacy, { maxDepth: 0 }), null);
  assert.throws(() => resolveAgent({ cwd: tmp() }), /no agent name/);
});

test('StatusFile writes session/bridge-<agent>.json, bumps counters, and is readable/removable', () => {
  const dir = tmp();
  let t = 100;
  const s = new StatusFile({ agent: 'Robo', sink: 'claude-channel', dir, pid: 42, now: () => t });
  s.update({ armed: true });
  assert.equal(statusPath('Robo', dir), path.join(dir, 'bridge-Robo.json'));
  assert.deepEqual(readStatus('Robo', dir), { agent: 'Robo', sink: 'claude-channel', pid: 42, armed: true, delivered: 0, lastDeliveredAt: null, startedAt: 100, updatedAt: 100 });
  t = 200;
  s.bump();
  assert.equal(readStatus('Robo', dir).delivered, 1);
  assert.equal(readStatus('Robo', dir).lastDeliveredAt, 200);
  s.remove();
  assert.equal(readStatus('Robo', dir), null);
});

test('StatusFile with a sid writes bridge-<agent>@<sid>.json — two sessions of one agent never clobber each other', () => {
  const dir = tmp();
  const personal = new StatusFile({ agent: 'Robo', sink: 'claude-channel', sid: 'claude-1-aa', dir, pid: 1, now: () => 1 });
  const relay = new StatusFile({ agent: 'Robo', sink: 'claude-channel', sid: 'claudeRelay-2-bb', dir, pid: 2, now: () => 1 });
  personal.update({ armed: true });
  relay.update({ armed: true });
  assert.equal(statusPath('Robo', dir, 'claudeRelay-2-bb'), path.join(dir, 'bridge-Robo@claudeRelay-2-bb.json'));
  relay.remove();
  assert.equal(readStatus('Robo', dir, 'claudeRelay-2-bb'), null);
  assert.equal(readStatus('Robo', dir, 'claude-1-aa').armed, true, 'the other session keeps its status');
});

test('Bridge: sink started and ARMED before the mailbox is attached; per message normalize -> pipeline -> sink -> status bump', async () => {
  const order = [];
  let armResolve;
  const sink = {
    name: 'fake',
    delivered: [],
    start: async () => order.push('sink.start'),
    waitArmed: () => new Promise((r) => { order.push('sink.waitArmed'); armResolve = r; }),
    deliver: async (ctx) => sink.delivered.push(ctx.envelope),
  };
  let deliverFn;
  const source = { start: async (fn) => { order.push('source.start'); deliverFn = fn; }, stop: async () => order.push('source.stop'), publish: async () => {} };
  const dir = tmp();
  const status = new StatusFile({ agent: 'Robo', sink: 'fake', dir, now: () => 1 });
  const pipeline = new Pipeline([{ name: 'drop-spam', handle: (ctx) => (ctx.envelope.from === 'Spam' ? HANDLED : 'continue') }]);
  const replies = [];
  const bridge = new Bridge({ agent: 'Robo', source, pipeline, sink, status, send: async (to, text) => replies.push([to, text]) });
  const running = bridge.run();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['sink.start', 'sink.waitArmed']);
  assert.equal(readStatus('Robo', dir).armed, false);
  armResolve();
  await running;
  assert.deepEqual(order, ['sink.start', 'sink.waitArmed', 'source.start']);
  assert.equal(readStatus('Robo', dir).armed, true);

  assert.deepEqual(await bridge.handle({ from: 'Spam', text: 'buy' }), { handledBy: 'drop-spam' });
  assert.deepEqual(await bridge.handle({ from: 'Friend', text: 'hi' }), { handledBy: null });
  assert.equal(sink.delivered.length, 1);
  assert.equal(sink.delivered[0].kind, 'message');
  assert.equal(readStatus('Robo', dir).delivered, 1);
  await bridge.stop();
  assert.equal(readStatus('Robo', dir), null);
  assert.throws(() => new Bridge({}), TypeError);
});

test('resolveMqttPort: explicit > vortexia.port.json > registry > 1883', async () => {
  const dir = tmp();
  const portFile = path.join(dir, 'vortexia.port.json');
  assert.equal(await resolveMqttPort({ explicit: '1111', portFile }), 1111);
  fs.writeFileSync(portFile, JSON.stringify({ mqttPort: 2222 }));
  assert.equal(await resolveMqttPort({ portFile, fetchImpl: async () => assert.fail('port file wins') }), 2222);
  fs.unlinkSync(portFile);
  const registry = async () => ({ ok: true, json: async () => ({ 9012: { app: 'vortexia-mqtt', port: 9012 } }) });
  assert.equal(await resolveMqttPort({ portFile, fetchImpl: registry }), 9012);
  assert.equal(await resolveMqttPort({ portFile, fetchImpl: async () => { throw new Error('down'); } }), 1883);
});
