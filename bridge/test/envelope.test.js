import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, KIND, MIC_SELFTEST_PING, isMicSelfTest, micSelfTestPong } from '../src/envelope.js';

test('normalize fills kind/ts/id and coerces fields, without touching a complete envelope', () => {
  const now = () => 1234;
  const bare = normalize({ from: 'A', to: 'B', text: 'hi' }, { now });
  assert.equal(bare.kind, KIND.MESSAGE);
  assert.equal(bare.ts, 1234);
  assert.equal(bare.source, 'agent');
  assert.equal(bare.id, 'A:1234:2');
  const full = normalize({ id: 'x', from: 'A', to: 'B', text: 'hi', kind: 'speak', ts: 9, source: 'human' }, { now });
  assert.deepEqual(full, { id: 'x', from: 'A', to: 'B', text: 'hi', kind: 'speak', ts: 9, source: 'human' });
  assert.equal(normalize(null, { now }).text, '');
  assert.equal(normalize({ text: 42 }, { now }).text, '42');
});

test('the mic self-test sentinel is classified by text, and the pong mirrors the CLI listener', () => {
  const env = normalize({ from: 'X', to: 'X', text: MIC_SELFTEST_PING, source: 'human' });
  assert.equal(env.kind, KIND.MIC_SELFTEST);
  assert.ok(isMicSelfTest(env));
  const pong = micSelfTestPong('X', { now: () => 5 });
  assert.deepEqual(pong, { from: 'X', to: 'X', source: 'system', kind: KIND.MIC_SELFTEST_PONG, text: 'OK', ts: 5 });
});

test('kind "cc" is a known kind and survives normalize() untouched (a for-the-record copy, never re-typed as a message)', () => {
  assert.equal(KIND.CC, 'cc');
  const env = normalize({ from: 'Robo', to: 'Robo', source: 'human', kind: 'cc', text: '[cc → shell] make test', ts: 1 });
  assert.equal(env.kind, KIND.CC);
  assert.equal(env.text, '[cc → shell] make test');
});

test('a message that crossed vortex-relay names its sender Name@env, so a same-named agent is not itself', () => {
  const relayed = normalize({ from: 'System', to: 'System', text: 'hi', kind: 'vortex-relay-delivery', routedFrom: 'uy-mac', ts: 1 });
  assert.equal(relayed.from, 'System@uy-mac');
  assert.equal(normalize({ from: 'System@uy-mac', routedFrom: 'uy-mac', text: 'x', ts: 1 }).from, 'System@uy-mac');
  assert.equal(normalize({ from: 'System', text: 'local', ts: 1 }).from, 'System');
});
