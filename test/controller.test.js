import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteControl } from '../src/controller.js';
import { RemoteControlError } from '../src/tunnel.js';

const options = {
  cloudflaredPath: 'cloudflared', target: 'http://127.0.0.1:3080',
  authenticatedUrl: value => `${value}/?token=never-published`,
  pairingTtlSeconds: 120, deviceTtlHours: 8, refreshTtlDays: 10,
  refreshAheadSeconds: 300, refreshRetrySeconds: 30, maxDevices: 4,
  startupTimeoutSeconds: 60, tunnelProtocol: 'http2',
};

function fixture(overrides = {}) {
  const counts = { bridges: 0, tunnels: 0, bridgeClose: 0, tunnelStop: 0 };
  let onExit;
  let pairCounter = 0;
  let expiresAt = null;
  let devices = [{ id: 'phone-1', label: 'My phone', pairedAt: 1, lastSeenAt: 1 }];
  const bridge = {
    origin: 'http://127.0.0.1:45678',
    setExternalOrigin() {},
    pairing() { expiresAt = Date.now() + 120000 + pairCounter++; return { url: `https://fixture.trycloudflare.com/__dsh_remote_pair#secret-${pairCounter}`, expiresAt }; },
    snapshot() { return { pairingExpiresAt: expiresAt, devices }; },
    renameDevice(id, label) { const device = devices.find(device => device.id === id); if (!device) return false; device.label = label; return true; },
    revokeDevice(id) { const found = devices.some(device => device.id === id); devices = devices.filter(device => device.id !== id); return found; },
    async close() { counts.bridgeClose++; expiresAt = null; devices = []; },
  };
  const control = new RemoteControl(options, {
    checkDependency: async () => ({ available: true }),
    createBridge: async () => { counts.bridges++; return bridge; },
    startTunnel: async input => { counts.tunnels++; onExit = input.onExit; return { publicUrl: 'https://fixture.trycloudflare.com', stop: async () => { counts.tunnelStop++; } }; },
    renderQr: async () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
    ...overrides,
  });
  return { control, counts, bridge, exit: error => onExit(error) };
}

test('initialization stays off and never opens a tunnel', async () => {
  const { control, counts } = fixture();
  const state = await control.initialize();
  assert.equal(state.phase, 'off');
  assert.equal(state.dependency.available, true);
  assert.equal(counts.bridges, 0);
  assert.equal(counts.tunnels, 0);
  await control.close();
});

test('unsupported listener authorities fail with an actionable error before allocating resources', async () => {
  for (const target of ['http://192.0.2.10:3080', 'http://0.0.0.0:3080', 'http://[::]:3080']) {
    const f = fixture();
    f.control.options = { ...options, target };
    await assert.rejects(f.control.enable(), error => error.code === 'LOOPBACK_REQUIRED' && error.message.includes('--host 127.0.0.1'));
    assert.equal(f.counts.bridges, 0);
    assert.equal(f.counts.tunnels, 0);
    await f.control.close();
  }
});

test('access and rolling refresh durations are passed to the bridge in milliseconds', async () => {
  let received;
  const f = fixture({ createBridge: async options => { received = options; return f.bridge; } });
  await f.control.enable();
  assert.equal(received.deviceTtlMs, 8 * 3600000);
  assert.equal(received.refreshTtlMs, 10 * 86400000);
  assert.equal(received.refreshAheadMs, 300000);
  assert.equal(received.refreshRetryMs, 30000);
  await f.control.close();
});

test('enable coalesces concurrent requests and summary never discloses pairing data', async () => {
  const { control, counts } = fixture();
  const [a, b] = await Promise.all([control.enable(), control.enable()]);
  assert.equal(a.phase, 'on');
  assert.equal(b.phase, 'on');
  assert.equal(counts.tunnels, 1);
  assert.ok(a.pairing.qrSvg.startsWith('data:image/svg+xml;base64,'));
  assert.equal('pairing' in control.summary(), false);
  assert.equal(JSON.stringify(control.summary()).includes('secret-'), false);
  assert.equal(JSON.stringify(control.summary()).includes('never-published'), false);
  await control.disable();
  assert.equal(control.snapshot().phase, 'off');
  assert.equal(control.snapshot().publicUrl, null);
  assert.equal(counts.bridgeClose, 1);
  assert.equal(counts.tunnelStop, 1);
});

test('disable cancels startup, drains resources, and cannot publish a late on state', async () => {
  let tunnelEntered;
  const entered = new Promise(resolve => { tunnelEntered = resolve; });
  const { control, counts } = fixture({
    startTunnel: async ({ signal }) => {
      tunnelEntered();
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new RemoteControlError('CANCELLED', 'cancelled')), { once: true });
      });
    },
  });
  const published = [];
  control.subscribe(state => published.push(state.phase));
  const starting = control.enable();
  await entered;
  await control.disable();
  await starting;
  assert.equal(control.snapshot().phase, 'off');
  assert.equal(published.includes('on'), false);
  assert.equal(counts.bridgeClose, 1);
});

test('a tunnel failure disconnects the bridge and clears the QR', async () => {
  const { control, counts, exit } = fixture();
  await control.enable();
  let failed;
  const observed = new Promise(resolve => { failed = resolve; });
  control.subscribe(state => { if (state.phase === 'error') failed(); });
  exit(new RemoteControlError('TUNNEL_EXITED', 'Tunnel stopped.'));
  await observed;
  assert.equal(control.snapshot().error.code, 'TUNNEL_EXITED');
  assert.equal(control.snapshot().pairing, null);
  assert.equal(control.snapshot().publicUrl, null);
  assert.equal(counts.bridgeClose, 1);
  await control.close();
});

test('a missing dependency is actionable and allocates no bridge', async () => {
  const { control, counts } = fixture({ checkDependency: async () => ({ available: false }) });
  await assert.rejects(control.enable(), { code: 'CLOUDFLARED_MISSING' });
  assert.equal(control.snapshot().phase, 'error');
  assert.equal(counts.bridges, 0);
  await control.close();
});

test('a later disable cancels an enable queued behind an earlier disable', async () => {
  const { control, bridge, counts } = fixture();
  await control.enable();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  bridge.close = async () => { counts.bridgeClose++; await gate; };
  const stopping = control.disable();
  const queued = control.enable();
  const latest = control.disable();
  release();
  await Promise.all([stopping, queued, latest]);
  assert.equal(control.snapshot().phase, 'off');
  assert.equal(counts.tunnels, 1);
});

test('disable waits for cleanup already started by tunnel failure', async () => {
  const { control, bridge, exit } = fixture();
  await control.enable();
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  bridge.close = async () => { entered(); await gate; };
  exit(new RemoteControlError('TUNNEL_EXITED', 'stopped'));
  await started;
  let stopped = false;
  const stopping = control.disable().then(() => { stopped = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(control.snapshot().phase, 'off');
});

test('a tunnel that exits before enable resumes cannot produce an on state', async () => {
  const { control } = fixture({ startTunnel: async ({ onExit }) => {
    onExit(new RemoteControlError('TUNNEL_EXITED', 'stopped before activation'));
    return { publicUrl: 'https://fixture.trycloudflare.com', async stop() {} };
  } });
  await assert.rejects(control.enable(), { code: 'TUNNEL_EXITED' });
  assert.equal(control.snapshot().phase, 'error');
  assert.equal(control.snapshot().pairing, null);
  await control.close();
});

test('cleanup failures stay visible and never report a successful off state', async () => {
  const { control, bridge, exit } = fixture();
  await control.enable();
  bridge.close = async () => { throw new Error('private cleanup details'); };
  let observed;
  const settled = new Promise(resolve => { observed = resolve; });
  control.subscribe(state => { if (state.error?.code === 'CLEANUP_FAILED') observed(); });
  exit(new RemoteControlError('TUNNEL_EXITED', 'stopped'));
  await settled;
  await assert.rejects(control.disable(), { code: 'CLEANUP_FAILED' });
  assert.equal(control.snapshot().phase, 'error');
  assert.equal(control.snapshot().error.message.includes('private'), false);
});

test('rename validates, publishes the updated device, and keeps pairing and resources intact', async () => {
  const { control, counts } = fixture();
  await control.enable();
  const before = control.snapshot();
  const published = [];
  control.subscribe(state => published.push(state));
  for (const label of [undefined, null, 123, '', '  ', 'a'.repeat(81), 'Ph\u0000one', 'Phone\n', 'Phone\u0085']) {
    assert.throws(() => control.renameDevice('phone-1', label), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => control.renameDevice('', 'Phone'), { code: 'INVALID_DEVICE' });
  assert.throws(() => control.renameDevice('missing', 'Phone'), { code: 'DEVICE_NOT_FOUND' });
  assert.equal(published.length, 0);
  const after = control.renameDevice('phone-1', '  工作手机  ');
  assert.equal(after.devices[0].label, '工作手机');
  assert.equal(published.at(-1).devices[0].label, '工作手机');
  assert.deepEqual(after.pairing, before.pairing);
  assert.equal(after.devices[0].id, before.devices[0].id);
  assert.equal(after.devices[0].pairedAt, before.devices[0].pairedAt);
  assert.equal(after.phase, 'on');
  assert.equal(counts.bridgeClose, 0);
  assert.equal(counts.tunnelStop, 0);
  await control.close();
  assert.throws(() => control.renameDevice('phone-1', 'Phone'), { code: 'DEVICE_NOT_FOUND' });
});

test('a QR that finishes generating after disable cannot reopen pairing', async () => {
  let renderCompleted;
  let renderEntered;
  const entered = new Promise(resolve => { renderEntered = resolve; });
  const rendered = new Promise(resolve => { renderCompleted = resolve; });
  const { control } = fixture({ renderQr: async () => { renderEntered(); await rendered; return '<svg/>'; } });
  const startup = control.enable();
  await entered;
  const stopping = control.disable();
  renderCompleted();
  await Promise.all([startup, stopping]);
  assert.equal(control.snapshot().phase, 'off');
  assert.equal(control.snapshot().pairing, null);
});
