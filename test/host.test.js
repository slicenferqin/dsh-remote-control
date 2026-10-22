import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { apply, Config } from '../index.js';
import { RemoteControl } from '../src/controller.js';

async function fixture() {
  const routes = new Map();
  const disposers = [];
  let tool;
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, origin).pathname);
    if (!handler) { res.writeHead(404).end(); return; }
    void Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ctx = {
    effect(register) { const dispose = register(); if (dispose) disposers.push(dispose); return () => {}; },
    webServer: {
      getOrigin: () => origin,
      register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); },
    },
    connection: {
      requestRejection(req) { return req.headers.cookie === 'fixture-owner=1' ? undefined : 401; },
      authenticatedUrl: base => `${base}/?token=private-fixture`,
    },
    tools: { register(definition) { tool = definition; return () => { tool = undefined; }; } },
  };
  await apply(ctx, Config({ cloudflaredPath: process.execPath }));
  return {
    origin, get tool() { return tool; },
    async request(path, options = {}) { return fetch(`${origin}/api/dsh-remote-control/${path}`, {
      ...options, headers: { Cookie: 'fixture-owner=1', ...options.headers },
    }); },
    async close() {
      for (const dispose of disposers.reverse()) await dispose();
      const closing = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closing;
    },
  };
}

test('invalid credential lifetime combinations fail before resources are created', async () => {
  await assert.rejects(apply({}, Config({ deviceTtlHours: 48, refreshTtlDays: 1 })), /refreshTtlDays must be longer/);
  await assert.rejects(apply({}, Config({ deviceTtlHours: 1, refreshAheadSeconds: 3600 })), /refreshAheadSeconds must be shorter/);
});

test('management endpoints require existing browser authentication and local Host', async t => {
  const f = await fixture(); t.after(() => f.close());
  const missing = await f.request('status', { headers: { Cookie: '' } });
  assert.equal(missing.status, 401);
  const foreign = await new Promise((resolve, reject) => {
    const request = http.get(`${f.origin}/api/dsh-remote-control/status`, { headers: { Host: 'remote.example.com', Cookie: 'fixture-owner=1' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.once('error', reject);
  });
  assert.equal(foreign, 403);
  const local = await f.request('status');
  assert.equal(local.status, 200);
  const state = await local.json();
  assert.equal(state.phase, 'off');
  assert.equal(state.dependency.available, true);
  assert.equal(state.pairing, null);
});

test('management mutations require a same-origin local browser request', async t => {
  const f = await fixture(); t.after(() => f.close());
  const missing = await f.request('control', { method: 'POST', body: '{"action":"disable"}' });
  assert.equal(missing.status, 403);
  const cross = await f.request('control', { method: 'POST', headers: { Origin: 'https://attacker.example.com' }, body: '{"action":"disable"}' });
  assert.equal(cross.status, 403);
  const invalid = await f.request('control', { method: 'POST', headers: { Origin: f.origin }, body: '{"action":"unknown"}' });
  assert.equal(invalid.status, 400);
  const valid = await f.request('control', { method: 'POST', headers: { Origin: f.origin }, body: '{"action":"disable"}' });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).phase, 'off');
});

test('agent tools can read or reduce access and cannot enable or issue credentials', async t => {
  const f = await fixture(); t.after(() => f.close());
  const tool = f.tool;
  assert.deepEqual(tool.parameters.oneOf.flatMap(branch => {
    const action = branch.properties.action;
    return action.enum ?? [action.const];
  }), ['status', 'disable', 'revoke', 'rename']);
  assert.ok(tool.parameters.oneOf.every(branch => branch.additionalProperties === false));
  const state = await tool.execute({ action: 'status' });
  assert.equal(state.phase, 'off');
  assert.equal('pairing' in state, false);
  assert.equal(JSON.stringify(state).includes('private-fixture'), false);
  await assert.rejects(tool.execute({ action: 'enable' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(tool.execute({ action: 'pair' }), { code: 'INVALID_REQUEST' });
  assert.equal((await tool.execute({ action: 'disable' })).phase, 'off');
});

test('local and agent rename share validation and publish without granting or removing access', async t => {
  let control;
  const initialize = RemoteControl.prototype.initialize;
  const capture = t.mock.method(RemoteControl.prototype, 'initialize', async function () {
    control = this;
    return initialize.call(this);
  });
  const f = await fixture(); t.after(() => f.close());
  capture.mock.restore();
  const device = { id: 'phone-1', label: 'My phone', pairedAt: 123, lastSeenAt: 123 };
  const calls = [];
  control.bridge = {
    snapshot: () => ({ devices: [{ ...device }], pairingExpiresAt: null }),
    renameDevice(id, label) { calls.push({ id, label }); if (id !== device.id) return false; device.label = label; return true; },
    async close() {},
  };
  control.phase = 'on';
  const published = [];
  control.subscribe(state => published.push(state));
  const post = body => f.request('control', {
    method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const body of [
    { action: 'rename', deviceId: 'phone-1' }, { action: 'rename', label: 'Phone' },
    { action: 'rename', deviceId: 'phone-1', label: 'Phone', expiresAt: 99 },
    { action: 'disable', label: 'Phone' }, { action: 'pair', deviceId: 'phone-1' },
    { action: 'revoke', deviceId: 'phone-1', label: 'Phone' },
    ...[undefined, null, 1, '', '  ', 'a'.repeat(81), 'Phone\n'].map(label => ({ action: 'rename', deviceId: 'phone-1', label })),
  ]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
    await assert.rejects(f.tool.execute(body), { code: 'INVALID_REQUEST' });
  }
  assert.equal(published.length, 0);
  assert.equal(calls.length, 0);
  const local = await post({ action: 'rename', deviceId: 'phone-1', label: '  Local phone  ' });
  assert.equal(local.status, 200);
  const localState = await local.json();
  assert.equal(localState.devices[0].label, 'Local phone');
  assert.equal(local.headers.get('set-cookie'), null);
  const agentState = await f.tool.execute({ action: 'rename', deviceId: 'phone-1', label: '  Agent phone  ' });
  assert.equal(agentState.devices[0].label, 'Agent phone');
  assert.equal(agentState.phase, 'on');
  assert.equal('pairing' in agentState, false);
  assert.deepEqual(calls, [{ id: 'phone-1', label: 'Local phone' }, { id: 'phone-1', label: 'Agent phone' }]);
  assert.equal(published.length, 2);
  assert.equal(published.at(-1).devices[0].label, 'Agent phone');
  assert.equal(device.id, 'phone-1');
  assert.equal(device.pairedAt, 123);
  assert.equal(f.tool.isConcurrencySafe({ action: 'rename' }), false);
  assert.equal((await post({ action: 'rename', deviceId: 'gone', label: 'Phone' })).status, 404);
  await assert.rejects(f.tool.execute({ action: 'rename', deviceId: 'gone', label: 'Phone' }), { code: 'DEVICE_NOT_FOUND' });
});

test('SSE opens with a complete snapshot and closes on unload', async t => {
  const f = await fixture(); t.after(() => f.close());
  const abort = new AbortController();
  const response = await f.request('events', { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  assert.ok(text.startsWith('data: '));
  const state = JSON.parse(text.slice(6).trim());
  assert.equal(state.phase, 'off');
  abort.abort();
  await reader.cancel().catch(() => {});
});
