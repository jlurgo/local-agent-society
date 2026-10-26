/**
 * Outbound: how a sink or interceptor answers a sender. Goes through the
 * backend's inject endpoint — the same path `las agent send` takes — so a
 * reply to `Name@other-mac` rides vortex-relay exactly like a CLI send
 * would. No second MQTT connection, no duplicated routing rules.
 */
const REGISTRY_URL = process.env.LAS_REGISTRY_URL || 'http://localhost:8700';

export function makeSender({ from, fetchImpl = globalThis.fetch, registryUrl = REGISTRY_URL } = {}) {
  return async function send(to, text, { source = 'agent' } = {}) {
    if (!to) throw new Error('send needs a recipient');
    const res = await fetchImpl(`${registryUrl}/agents/${encodeURIComponent(to)}/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: String(text), source, from_agent: from }),
    });
    if (!res.ok) {
      const detail = await res.json().then((b) => b && b.detail, () => null);
      throw new Error(`inject to ${to} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
    return res.json().catch(() => ({}));
  };
}
