import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteControl } from '../src/controller.js';
import { RemoteControlError } from '../src/tunnel.js';

const PUBLIC_ORIGIN = 'https://dsh.clawplay.club';
const REFRESH_HASH = 'd'.repeat(64);
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
const clone = value => structuredClone(value);
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mockStore(initialIntent = null) {
  let intent = initialIntent;
  let registry = { version: 1, origin: PUBLIC_ORIGIN, devices: [{
    id: '12345678-1234-4123-8123-123456789abc', label: 'Paired phone',
    pairedAt: 100, lastSeenAt: 200, refreshHash: REFRESH_HASH, refreshExpiresAt: 8640000000000,
  }] };
  const calls = { loads: 0, saves: [], clears: 0, intents: [] };
  return {
    calls,
    load() { calls.loads++; return clone(registry); },
    save(value) { registry = clone(value); calls.saves.push(clone(value)); },
    clear() { calls.clears++; registry = { version: 1, origin: null, devices: [] }; },
    readIntent() { return intent; },
    writeIntent(value) { intent = value; calls.intents.push(value); },
    inspect() { return { intent, registry: clone(registry) }; },
  };
}
function mockTimers() {
  let now = 0;
  let counter = 0;
  const pending = new Map();
  const scheduled = [];
  const cancelled = [];
  return {
    pending, scheduled, cancelled,
    setTimeout(callback, delay) {
      assert.ok(Number.isFinite(delay) && delay > 0, 'retries must use a bounded positive delay');
      const handle = { id: ++counter, unref() {} };
      pending.set(handle, { callback, delay, due: now + delay });
      scheduled.push(delay);
      return handle;
    },
    clearTimeout(handle) { cancelled.push(handle); pending.delete(handle); },
    async advance(milliseconds) {
      const end = now + milliseconds;
      let iterations = 0;
      while (true) {
        const next = [...pending.entries()].filter(([, value]) => value.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        assert.ok(++iterations < 100, 'timer callbacks must not spin without a bounded wait');
        const [handle, value] = next;
        now = value.due;
        pending.delete(handle);
        value.callback();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
function fixture({ config = {}, store = mockStore(), timers = mockTimers(), hooks = {} } = {}) {
  const events = [];
  const bridges = [];
  const carriers = [];
  const calls = { dependency: [], createBridge: [], startTunnel: [] };
  const options = {
    tunnelMode: 'ssh', sshPath: '/fixture/bin/ssh', sshTarget: 'dsh-restricted-vps',
    sshConfigPath: '/private/ssh/DO-NOT-PUBLISH-config', sshRemotePort: 18380,
    publicOrigin: PUBLIC_ORIGIN, autoStart: true, deviceStore: store,
    target: 'http://127.0.0.1:3080',
    authenticatedUrl: value => `${value}/?token=DSH-ROOT-CREDENTIAL`,
    pairingTtlSeconds: 120, deviceTtlHours: 8, refreshTtlDays: 10,
    refreshAheadSeconds: 300, refreshRetrySeconds: 30, maxDevices: 4,
    startupTimeoutSeconds: 45, tunnelProtocol: 'http2', ...config,
  };
  const control = new RemoteControl(options, {
    checkDependency: async binary => { calls.dependency.push(binary); return { available: true }; },
    setTimeout: (callback, delay) => timers.setTimeout(callback, delay),
    clearTimeout: handle => timers.clearTimeout(handle),
    renderQr: async () => '<svg>PRIVATE-PAIRING-QR</svg>',
    createBridge: async input => {
      calls.createBridge.push(input);
      const registry = store.load();
      const number = bridges.length + 1;
      let externalOrigin;
      let expiresAt = null;
      const bridge = {
        origin: `http://127.0.0.1:${45670 + number}`, closeCalls: [],
        health: () => ({ ok: true, service: 'dsh-remote-control', entryId: `entry-${number}` }),
        setExternalOrigin(value) {
          events.push(`bridge-${number}:setExternalOrigin`);
          externalOrigin = value;
        },
        pairing() {
          assert.equal(externalOrigin, PUBLIC_ORIGIN);
          expiresAt = Date.now() + 120000;
          return { url: `${externalOrigin}/__dsh_remote_pair#PAIRING-SECRET-${number}`, expiresAt };
        },
        snapshot: () => ({ pairingExpiresAt: expiresAt,
          devices: registry.devices.map(({ refreshHash: _secret, ...device }) => clone(device)) }),
        async close(value) {
          bridge.closeCalls.push(clone(value));
          events.push(`bridge-${number}:close`);
          await hooks.closeBridge?.({ input: value, bridge });
          expiresAt = null;
          if (value.preserveDevices) store.save(registry);
          else store.clear();
        },
      };
      bridges.push(bridge);
      await hooks.beforeBridgeReturn?.({ bridge, input, attempt: number });
      return bridge;
    },
    startTunnel: async input => {
      calls.startTunnel.push(input);
      events.push(`provider-${calls.startTunnel.length}:start`);
      const carrier = { publicUrl: PUBLIC_ORIGIN, stopCalls: 0,
        getHealth: () => ({ status: 'online', checkedAt: Date.now() }),
        async stop() { carrier.stopCalls++; } };
      carriers.push(carrier);
      const result = await hooks.startTunnel?.({ input, carrier, attempt: calls.startTunnel.length });
      return result === undefined ? carrier : result;
    },
  });
  return { control, store, timers, options, events, bridges, carriers, calls };
}

// No test starts a real bridge, subprocess, network probe, filesystem store, or native timer.
test('SSH integration passes all configuration and establishes external origin before provider startup', async () => {
  const run = fixture();
  await run.control.initialize();
  assert.deepEqual(run.calls.dependency, ['/fixture/bin/ssh']);
  assert.equal(run.calls.startTunnel.length, 0);
  const state = await run.control.enable();
  const input = run.calls.startTunnel[0];
  assert.equal(state.phase, 'on');
  assert.deepEqual(run.events.slice(0, 2), ['bridge-1:setExternalOrigin', 'provider-1:start']);
  assert.equal(input.binary, run.options.sshPath);
  assert.equal(input.target, run.options.sshTarget);
  assert.equal(input.configPath, run.options.sshConfigPath);
  assert.equal(input.origin, run.bridges[0].origin);
  assert.equal(input.publicUrl, PUBLIC_ORIGIN);
  assert.equal(input.remotePort, 18380);
  assert.equal(input.expectedEntryId, run.bridges[0].health().entryId);
  assert.equal(input.timeoutMs, 45000);
  assert.ok(input.signal instanceof AbortSignal);
  assert.equal(input.signal.aborted, false);
  assert.equal(typeof input.onHealth, 'function');
  assert.equal(typeof input.onExit, 'function');
  assert.equal(run.calls.createBridge[0].deviceStore, run.store);
  assert.equal(run.store.readIntent(), true);
  await run.control.close();
});

test('reconnecting health preserves the live bridge, grants, pairing, and persistent enable intent', async () => {
  const run = fixture();
  await run.control.enable();
  const pairing = run.control.snapshot().pairing;
  const health = { status: 'reconnecting', checkedAt: 1234, retryAt: 2234,
    error: { code: 'SSH_EXITED', message: 'The SSH connection stopped.' } };
  run.calls.startTunnel[0].onHealth(health);
  const state = run.control.snapshot();
  assert.equal(state.phase, 'on');
  assert.deepEqual(state.connection, health);
  assert.deepEqual(state.pairing, pairing);
  assert.equal(state.devices.length, 1);
  assert.equal(run.bridges[0].closeCalls.length, 0);
  assert.equal(run.carriers[0].stopCalls, 0);
  assert.equal(run.store.calls.clears, 0);
  assert.equal(run.store.inspect().registry.devices[0].refreshHash, REFRESH_HASH);
  assert.equal(run.store.readIntent(), true);
  await run.control.close();
});

test('lifecycle close preserves paired-device grants and durable enabled intent', async () => {
  const store = mockStore();
  const run = fixture({ store });
  await run.control.enable();
  await run.control.close();
  assert.deepEqual(run.bridges[0].closeCalls, [{ preserveDevices: true }]);
  assert.equal(run.carriers[0].stopCalls, 1);
  assert.equal(store.calls.clears, 0);
  assert.equal(store.readIntent(), true);
  assert.equal(store.inspect().registry.devices[0].refreshHash, REFRESH_HASH);
  const next = fixture({ store });
  const restored = await next.control.restore();
  assert.equal(restored.phase, 'on');
  assert.equal(restored.devices[0].id, '12345678-1234-4123-8123-123456789abc');
  await next.control.close();
});

test('explicit disable durably revokes grants and a fresh controller cannot restore that entry', async () => {
  const store = mockStore();
  const run = fixture({ store });
  await run.control.enable();
  await run.control.disable();
  assert.deepEqual(run.bridges[0].closeCalls, [{ preserveDevices: false }]);
  assert.equal(store.readIntent(), false);
  assert.deepEqual(store.inspect().registry.devices, []);
  assert.ok(store.calls.clears > 0);
  await run.control.close();
  const next = fixture({ store });
  const state = await next.control.restore();
  assert.equal(state.phase, 'off');
  assert.equal(next.calls.createBridge.length, 0);
  assert.equal(next.calls.startTunnel.length, 0);
  assert.equal(store.readIntent(), false);
  await next.control.close();
});

test('restore requires config autoStart and honors a persisted explicit off', async () => {
  for (const autoStart of [false, true]) {
    for (const intent of [null, false, true]) {
      const store = mockStore(intent);
      const run = fixture({ config: { autoStart }, store });
      const state = await run.control.restore();
      const shouldStart = autoStart && intent !== false;
      assert.equal(state.phase, shouldStart ? 'on' : 'off', `autoStart=${autoStart}, intent=${intent}`);
      assert.equal(run.calls.startTunnel.length, shouldStart ? 1 : 0);
      if (!shouldStart) assert.equal(store.readIntent(), intent);
      await run.control.close();
    }
  }
});

test('startup failures retain grants and retry at a bounded delay until recovery', async () => {
  const run = fixture({ hooks: { startTunnel({ attempt }) {
    if (attempt <= 2) throw new RemoteControlError('SSH_TIMEOUT', 'The SSH tunnel did not become healthy in time.');
  } } });
  await assert.rejects(run.control.enable(), { code: 'SSH_TIMEOUT' });
  assert.equal(run.control.snapshot().phase, 'error');
  assert.equal(run.store.readIntent(), true);
  assert.equal(run.store.calls.clears, 0);
  assert.deepEqual(run.bridges[0].closeCalls, [{ preserveDevices: true }]);
  assert.deepEqual(run.timers.scheduled, [15000]);
  assert.equal(run.timers.pending.size, 1);
  await run.timers.advance(14999);
  assert.equal(run.calls.startTunnel.length, 1);
  await run.timers.advance(1);
  assert.equal(run.calls.startTunnel.length, 2);
  assert.equal(run.timers.pending.size, 1);
  assert.equal(run.store.calls.clears, 0);
  await run.timers.advance(15000);
  assert.equal(run.calls.startTunnel.length, 3);
  assert.equal(run.control.snapshot().phase, 'on');
  assert.equal(run.control.snapshot().devices.length, 1);
  assert.equal(run.timers.pending.size, 0);
  await run.control.close();
});

test('manual startup failure does not silently enable automatic retries when autoStart is false', async () => {
  const run = fixture({ config: { autoStart: false }, hooks: { startTunnel() { throw new Error('PRIVATE-SSH-DETAIL'); } } });
  await assert.rejects(run.control.enable());
  assert.equal(run.control.summary().error.code, 'REMOTE_CONTROL_FAILED');
  assert.equal(JSON.stringify(run.control.summary()).includes('PRIVATE-SSH-DETAIL'), false);
  assert.equal(run.timers.pending.size, 0);
  await run.timers.advance(120000);
  assert.equal(run.calls.startTunnel.length, 1);
  assert.equal(run.store.inspect().registry.devices.length, 1);
  await run.control.close();
});

for (const action of ['disable', 'close']) {
  test(`${action} cancels a pending startup retry with the correct grant and intent policy`, async () => {
    const run = fixture({ hooks: { startTunnel() { throw new RemoteControlError('SSH_TIMEOUT', 'SSH timed out.'); } } });
    await assert.rejects(run.control.enable(), { code: 'SSH_TIMEOUT' });
    assert.equal(run.timers.pending.size, 1);
    await run.control[action]();
    assert.equal(run.timers.pending.size, 0);
    assert.equal(run.store.readIntent(), action === 'close');
    assert.equal(run.store.inspect().registry.devices.length, action === 'close' ? 1 : 0);
    await run.timers.advance(120000);
    assert.equal(run.calls.startTunnel.length, 1);
    assert.equal(run.control.snapshot().phase, 'off');
  });

  test(`${action} drains a provider that ignores abort and returns after shutdown began`, async () => {
    const entered = deferred();
    const late = deferred();
    const run = fixture({ hooks: { async startTunnel() { entered.resolve(); await late.promise; } } });
    const phases = [];
    run.control.subscribe(state => phases.push(state.phase));
    const starting = run.control.enable();
    await entered.promise;
    const signal = run.calls.startTunnel[0].signal;
    let closed = false;
    const stopping = run.control[action]().then(() => { closed = true; });
    await flush();
    assert.equal(signal.aborted, true);
    assert.equal(closed, false);
    late.resolve();
    await Promise.all([starting, stopping]);
    assert.equal(run.control.snapshot().phase, 'off');
    assert.equal(phases.includes('on'), false);
    assert.equal(run.carriers[0].stopCalls, 1);
    assert.deepEqual(run.bridges[0].closeCalls, [{ preserveDevices: action === 'close' }]);
    assert.equal(run.store.readIntent(), action === 'close');
    assert.equal(run.store.inspect().registry.devices.length, action === 'close' ? 1 : 0);
    await run.timers.advance(120000);
    assert.equal(run.calls.startTunnel.length, 1);
  });

  test(`${action} owns and closes a bridge that arrives after its startup was cancelled`, async () => {
    const entered = deferred();
    const late = deferred();
    const run = fixture({ hooks: { async beforeBridgeReturn() { entered.resolve(); await late.promise; } } });
    const starting = run.control.enable();
    await entered.promise;
    const stopping = run.control[action]();
    await flush();
    late.resolve();
    await Promise.all([starting, stopping]);
    assert.equal(run.control.snapshot().phase, 'off');
    assert.equal(run.calls.startTunnel.length, 0);
    assert.deepEqual(run.bridges[0].closeCalls, [{ preserveDevices: action === 'close' }]);
    assert.equal(run.store.readIntent(), action === 'close');
    assert.equal(run.store.inspect().registry.devices.length, action === 'close' ? 1 : 0);
  });

  test(`${action} also cancels startup already entered by the retry callback`, async () => {
    const entered = deferred();
    const late = deferred();
    const run = fixture({ hooks: { async startTunnel({ attempt }) {
      if (attempt === 1) throw new RemoteControlError('SSH_TIMEOUT', 'SSH timed out.');
      entered.resolve();
      await late.promise;
    } } });
    await assert.rejects(run.control.enable(), { code: 'SSH_TIMEOUT' });
    await run.timers.advance(15000);
    await entered.promise;
    const stopping = run.control[action]();
    await flush();
    assert.equal(run.calls.startTunnel[1].signal.aborted, true);
    late.resolve();
    await stopping;
    await run.timers.advance(120000);
    assert.equal(run.calls.startTunnel.length, 2);
    assert.equal(run.carriers[1].stopCalls, 1);
    assert.equal(run.control.snapshot().phase, 'off');
    assert.equal(run.store.readIntent(), action === 'close');
  });
}

test('late health from an old carrier cannot overwrite a disabled or replacement entry', async () => {
  const run = fixture();
  await run.control.enable();
  const oldHealth = run.calls.startTunnel[0].onHealth;
  await run.control.disable();
  oldHealth({ status: 'online', checkedAt: 1 });
  assert.equal(run.control.snapshot().connection.status, 'offline');
  await run.control.enable();
  const current = run.control.snapshot().connection;
  oldHealth({ status: 'reconnecting', checkedAt: 2 });
  assert.deepEqual(run.control.snapshot().connection, current);
  await run.control.close();
  run.calls.startTunnel[1].onHealth({ status: 'online', checkedAt: 3 });
  assert.equal(run.control.snapshot().phase, 'off');
});

test('summary excludes pairing URL, QR payload, refresh credentials, root token, and SSH config path', async () => {
  const run = fixture();
  const state = await run.control.enable();
  assert.ok(state.pairing.url.includes('PAIRING-SECRET'));
  assert.ok(state.pairing.qrSvg.startsWith('data:image/svg+xml;base64,'));
  const summary = run.control.summary();
  assert.equal(summary.pairingAvailable, true);
  assert.equal(Object.hasOwn(summary, 'pairing'), false);
  assert.equal(summary.devices.length, 1);
  const encoded = JSON.stringify(summary);
  for (const secret of ['PAIRING-SECRET', 'PRIVATE-PAIRING-QR', 'data:image/svg',
    'refreshHash', REFRESH_HASH, 'DSH-ROOT-CREDENTIAL', 'DO-NOT-PUBLISH-config']) {
    assert.equal(encoded.includes(secret), false, `summary must not contain ${secret}`);
  }
  await run.control.close();
});

test('enable after lifecycle disposal cannot change a stored explicit off intent', async () => {
  const store = mockStore(false);
  const run = fixture({ store });
  await run.control.close();
  const writes = store.calls.intents.length;
  await assert.rejects(run.control.enable(), { code: 'DISPOSED' });
  assert.equal(store.readIntent(), false);
  assert.equal(store.calls.intents.length, writes);
  assert.equal(run.calls.createBridge.length, 0);
  assert.equal(run.calls.startTunnel.length, 0);
});

test('a durable-off write failure is observable even while previous cleanup is pending', async () => {
  const cleanup = deferred();
  const entered = deferred();
  const store = mockStore();
  const writeIntent = store.writeIntent;
  let offWrites = 0;
  store.writeIntent = value => {
    if (value === false && ++offWrites === 2) throw new Error('fixture durable-off write failed');
    return writeIntent(value);
  };
  const run = fixture({ store, hooks: { async closeBridge() { entered.resolve(); await cleanup.promise; } } });
  await run.control.enable();
  const firstDisable = run.control.disable();
  await entered.promise;
  const queuedEnable = run.control.enable();
  const failedDisable = assert.rejects(Promise.resolve().then(() => run.control.disable()), /fixture durable-off write failed/);
  await flush();
  cleanup.resolve();
  await Promise.all([firstDisable, queuedEnable, failedDisable]);
  assert.equal(run.calls.startTunnel.length, 1);
  assert.equal(run.control.snapshot().phase, 'error');
});

test('a second explicit disable overrides intent written by an enable queued behind pending cleanup', async () => {
  const cleanup = deferred();
  const entered = deferred();
  const store = mockStore();
  const run = fixture({ store, hooks: { async closeBridge() { entered.resolve(); await cleanup.promise; } } });
  await run.control.enable();
  const firstDisable = run.control.disable();
  await entered.promise;
  assert.equal(store.readIntent(), false);
  const queuedEnable = run.control.enable();
  assert.equal(store.readIntent(), true);
  const finalDisable = run.control.disable();
  cleanup.resolve();
  await Promise.all([firstDisable, queuedEnable, finalDisable]);
  assert.equal(run.control.snapshot().phase, 'off');
  assert.equal(run.calls.startTunnel.length, 1);
  assert.equal(store.readIntent(), false, 'the final explicit disable must persist off even while another disable is pending');
  const next = fixture({ store });
  await next.control.restore();
  assert.equal(next.calls.startTunnel.length, 0);
  await next.control.close();
});
