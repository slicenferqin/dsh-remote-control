import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startSshTunnel, checkSsh } from '../src/ssh-tunnel.js';

const HEALTH = { ok: true, service: 'dsh-remote-control', entryId: 'local-entry' };
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function fakeChild({ ignoreTerm = false, autoClose = true } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = signal => {
    child.kills.push(signal);
    if (autoClose && (!ignoreTerm || signal === 'SIGKILL')) queueMicrotask(() => child.emit('close', 0, signal));
    return true;
  };
  return child;
}
function acknowledge(child) {
  child.stderr.write('debug1: remote forward success for: listen 127.0.0.1:4567, connect 127.0.0.1:45678\n');
}
function clock(context) { context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 }); }
function harness(extra = {}) {
  const children = [];
  const health = [];
  let onExitCalls = 0;
  const starting = startSshTunnel({ target: 'restricted-vps', configPath: '/private/test/config',
    origin: 'http://127.0.0.1:45678', publicUrl: 'https://dsh.clawplay.club', remotePort: 4567,
    expectedEntryId: 'local-entry', timeoutMs: 10000,
    spawnProcess() { const child = fakeChild(); children.push(child); return child; },
    probe: async () => HEALTH, onHealth: value => health.push(value), onExit: () => { onExitCalls++; }, ...extra });
  return { starting, children, health, get onExitCalls() { return onExitCalls; } };
}
async function connected(extra = {}) {
  const run = harness(extra);
  acknowledge(run.children[0]);
  run.tunnel = await run.starting;
  return run;
}

test('SSH args restrict forwarding and readiness requires the owned forwarding ACK plus matching health', async () => {
  const child = fakeChild();
  let invocation;
  let probes = 0;
  const run = harness({ spawnProcess(...args) { invocation = args; return child; },
    probe: async (url, options) => {
      probes++;
      assert.equal(url, 'https://dsh.clawplay.club/__dsh_remote_health');
      assert.equal(options.expectedEntryId, 'local-entry');
      assert.equal(options.timeoutMs, 5000);
      return HEALTH;
    } });
  await flush();
  assert.equal(probes, 0);
  const [binary, args, options] = invocation;
  assert.equal(binary, 'ssh');
  assert.deepEqual(args, ['-F', '/private/test/config', '-NT', '-v', '-oBatchMode=yes',
    '-oExitOnForwardFailure=yes', '-oServerAliveInterval=15', '-oServerAliveCountMax=3',
    '-oConnectTimeout=10', '-S', 'none', '-oControlMaster=no', '-R',
    '127.0.0.1:4567:127.0.0.1:45678', 'restricted-vps']);
  assert.equal(options.shell, undefined);
  child.stderr.write('debug1: remote forward succ');
  await flush();
  assert.equal(probes, 0);
  child.stderr.write('ess for: listen 127.0.0.1:4567\n');
  const tunnel = await run.starting;
  assert.equal(probes, 1);
  assert.equal(tunnel.publicUrl, 'https://dsh.clawplay.club');
  assert.equal(tunnel.getHealth().status, 'online');
  await tunnel.stop();
  await tunnel.stop();
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('invalid targets and non-loopback or insecure URLs never allocate a process', async () => {
  for (const config of [{ target: '-oProxyCommand=bad' }, { target: 'host;echo bad' },
    { target: 'host\n-oForwardAgent=yes' }, { target: 'user@-host' }, { origin: 'http://192.168.1.2:4000' },
    { publicUrl: 'http://dsh.clawplay.club' }, { publicUrl: 'https://user:secret@dsh.clawplay.club' },
    { publicUrl: 'https://dsh.clawplay.club/other' }, { remotePort: 0 }, { expectedEntryId: '' }]) {
    let spawned = false;
    const run = harness({ ...config, spawnProcess() { spawned = true; } });
    await assert.rejects(run.starting, { code: 'SSH_CONFIG_INVALID' });
    assert.equal(spawned, false);
  }
});

test('stale and malformed health responses cannot mark the tunnel ready', async context => {
  clock(context);
  let response = { ...HEALTH, entryId: 'old-entry' };
  const run = harness({ probe: async () => response });
  let ready = false;
  run.starting.then(() => { ready = true; });
  acknowledge(run.children[0]);
  await flush();
  assert.equal(ready, false);
  assert.equal(run.health.at(-1).error.code, 'SSH_HEALTH_ENTRY_MISMATCH');
  response = { ...HEALTH, service: 'other-service' };
  context.mock.timers.tick(500);
  await flush();
  assert.equal(ready, false);
  assert.equal(run.health.at(-1).error.code, 'SSH_HEALTH_INVALID');
  response = HEALTH;
  context.mock.timers.tick(500);
  const tunnel = await run.starting;
  assert.equal(ready, true);
  await tunnel.stop();
});

test('a healthy old public endpoint cannot hide this SSH process failing its forward', async () => {
  let probes = 0;
  const run = harness({ probe: async () => { probes++; return HEALTH; } });
  run.children[0].stderr.write('Error: remote port forwarding failed for listen port 4567\n');
  await assert.rejects(run.starting, { code: 'SSH_FORWARD_FAILED' });
  assert.equal(probes, 0);
  assert.deepEqual(run.children[0].kills, ['SIGTERM']);
});

test('exit during an in-flight successful public probe never resolves first readiness', async () => {
  let release;
  const run = harness({ probe: () => new Promise(resolve => { release = resolve; }) });
  acknowledge(run.children[0]);
  await flush();
  run.children[0].emit('exit', 255, null);
  run.children[0].emit('close', 255, null);
  release(HEALTH);
  await assert.rejects(run.starting, { code: 'SSH_EXITED' });
  assert.equal(run.health.some(value => value.status === 'online'), false);
});

test('pre-aborted startup never spawns, and abort inside spawn still joins the handed-back child', async () => {
  const signal = new AbortController();
  signal.abort();
  let spawned = false;
  await assert.rejects(harness({ signal: signal.signal, spawnProcess() { spawned = true; } }).starting,
    { code: 'CANCELLED' });
  assert.equal(spawned, false);
  const duringSpawn = new AbortController();
  const child = fakeChild();
  const run = harness({ signal: duringSpawn.signal, spawnProcess() { duringSpawn.abort(); return child; } });
  await assert.rejects(run.starting, { code: 'CANCELLED' });
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('abort between forwarding ACK and the queued probe does not start a late request', async () => {
  const abort = new AbortController();
  let probes = 0;
  const run = harness({ signal: abort.signal, probe: async () => { probes++; return HEALTH; } });
  acknowledge(run.children[0]);
  await Promise.resolve();
  abort.abort();
  await assert.rejects(run.starting, { code: 'CANCELLED' });
  assert.equal(probes, 0);
  assert.deepEqual(run.children[0].kills, ['SIGTERM']);
});

test('abort cancels an uncooperative probe and ignores its late success', async () => {
  const abort = new AbortController();
  let release;
  let probeSignal;
  const run = harness({ signal: abort.signal,
    probe: (url, { signal }) => { probeSignal = signal; return new Promise(resolve => { release = resolve; }); } });
  acknowledge(run.children[0]);
  await flush();
  abort.abort();
  await assert.rejects(run.starting, { code: 'CANCELLED' });
  assert.equal(probeSignal.aborted, true);
  release(HEALTH);
  await flush();
  assert.equal(run.health.some(value => value.status === 'online'), false);
  assert.deepEqual(run.children[0].kills, ['SIGTERM']);
});

test('startup deadline cancels probe, escalates after two seconds, and waits for the child', async context => {
  clock(context);
  const child = fakeChild({ ignoreTerm: true });
  let probeSignal;
  const run = harness({ timeoutMs: 1000, spawnProcess: () => child,
    probe: (url, { signal }) => { probeSignal = signal; return new Promise(() => {}); } });
  const rejected = assert.rejects(run.starting, { code: 'SSH_TIMEOUT' });
  acknowledge(child);
  await flush();
  context.mock.timers.tick(1000);
  await flush();
  assert.equal(probeSignal.aborted, true);
  assert.deepEqual(child.kills, ['SIGTERM']);
  context.mock.timers.tick(1999);
  await flush();
  assert.deepEqual(child.kills, ['SIGTERM']);
  context.mock.timers.tick(1);
  await rejected;
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
});

test('unexpected child exit keeps the wrapper and retries without invoking the parent teardown callback', async context => {
  clock(context);
  const run = await connected();
  run.children[0].emit('close', 255, null);
  await flush();
  assert.equal(run.onExitCalls, 0);
  assert.equal(run.tunnel.getHealth().status, 'reconnecting');
  assert.equal(run.tunnel.getHealth().retryAt - Date.now(), 1000);
  context.mock.timers.tick(999);
  await flush();
  assert.equal(run.children.length, 1);
  context.mock.timers.tick(1);
  await flush();
  assert.equal(run.children.length, 2);
  acknowledge(run.children[1]);
  await flush();
  assert.equal(run.tunnel.getHealth().status, 'online');
  await run.tunnel.stop();
});

test('retry backoff grows from one second and caps at thirty seconds', async context => {
  clock(context);
  const run = await connected();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    run.children.at(-1).emit('close', 255, null);
    await flush();
    assert.equal(run.tunnel.getHealth().retryAt - Date.now(), delay);
    const before = run.children.length;
    context.mock.timers.tick(delay);
    await flush();
    assert.equal(run.children.length, before + 1);
  }
  await run.tunnel.stop();
});

test('periodic public probe detects an unhealthy live SSH connection and reconnects', async context => {
  clock(context);
  let healthy = true;
  const run = await connected({ probe: async () => {
    if (!healthy) throw new Error('secret network details /private/key');
    return HEALTH;
  } });
  healthy = false;
  context.mock.timers.tick(5000);
  await flush();
  assert.deepEqual(run.children[0].kills, ['SIGTERM']);
  assert.equal(run.tunnel.getHealth().error.code, 'SSH_HEALTH_UNREACHABLE');
  assert.equal(JSON.stringify(run.health).includes('/private/key'), false);
  context.mock.timers.tick(1000);
  await flush();
  healthy = true;
  acknowledge(run.children[1]);
  await flush();
  assert.equal(run.tunnel.getHealth().status, 'online');
  await run.tunnel.stop();
});

test('a periodic probe has a wall timeout even if an injected implementation ignores abort', async context => {
  clock(context);
  let probes = 0;
  let signal;
  const run = await connected({ probe: (url, options) => {
    if (++probes === 1) return HEALTH;
    signal = options.signal;
    return new Promise(() => {});
  } });
  context.mock.timers.tick(5000);
  await flush();
  context.mock.timers.tick(5000);
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(run.tunnel.getHealth().error.code, 'SSH_HEALTH_TIMEOUT');
  await run.tunnel.stop();
});

test('authentication failures report a safe explicit status and remain retryable', async context => {
  clock(context);
  const run = await connected();
  run.children[0].emit('close', 255, null);
  await flush();
  context.mock.timers.tick(1000);
  await flush();
  run.children[1].stderr.write('/private/secret-key: Permission de');
  run.children[1].stderr.write('nied (publickey).\n');
  await flush();
  const health = run.tunnel.getHealth();
  assert.equal(health.status, 'offline');
  assert.equal(health.error.code, 'SSH_AUTH_FAILED');
  assert.equal(health.retryAt - Date.now(), 2000);
  assert.equal(JSON.stringify(run.health).includes('/private/secret-key'), false);
  context.mock.timers.tick(2000);
  await flush();
  acknowledge(run.children[2]);
  await flush();
  assert.equal(run.tunnel.getHealth().status, 'online');
  await run.tunnel.stop();
});

test('stop during backoff prohibits later spawns, even after a late ACK', async context => {
  clock(context);
  const run = await connected();
  run.children[0].emit('close', 255, null);
  await flush();
  await run.tunnel.stop();
  acknowledge(run.children[0]);
  context.mock.timers.tick(120000);
  await flush();
  assert.equal(run.children.length, 1);
  assert.equal(run.tunnel.getHealth().status, 'offline');
});

test('stop cancels in-flight health, joins its own child, and ignores late probe success', async context => {
  clock(context);
  const child = fakeChild({ autoClose: false });
  let probes = 0;
  let release;
  let probeSignal;
  const run = harness({ spawnProcess: () => child,
    probe: (url, { signal }) => {
      if (++probes === 1) return HEALTH;
      probeSignal = signal;
      return new Promise(resolve => { release = resolve; });
    } });
  acknowledge(child);
  run.tunnel = await run.starting;
  context.mock.timers.tick(5000);
  await flush();
  let stopped = false;
  const stopping = run.tunnel.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(probeSignal.aborted, true);
  assert.equal(stopped, false);
  release(HEALTH);
  await flush();
  assert.equal(run.tunnel.getHealth().status, 'offline');
  context.mock.timers.tick(2000);
  await flush();
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(stopped, false);
  child.emit('close', null, 'SIGKILL');
  await stopping;
  assert.equal(stopped, true);
});

test('observer cancellation cannot turn initial online health into successful startup', async () => {
  const abort = new AbortController();
  const run = harness({ signal: abort.signal, onHealth: value => {
    if (value.status === 'online') abort.abort();
  } });
  acknowledge(run.children[0]);
  await assert.rejects(run.starting, { code: 'CANCELLED' });
  assert.deepEqual(run.children[0].kills, ['SIGTERM']);
});

test('spawn errors are bounded and do not publish private process diagnostics', async () => {
  const run = harness();
  const child = run.children[0];
  child.pid = undefined;
  child.emit('error', Object.assign(new Error('/private/key secret'), { code: 'ENOENT' }));
  await assert.rejects(run.starting, error => error.code === 'SSH_MISSING' && !error.message.includes('/private'));
});

test('stop is reentrant when an offline observer calls stop again', async () => {
  let tunnel;
  let reentrant;
  const run = await connected({ onHealth: value => {
    if (value.status === 'offline' && tunnel) reentrant = tunnel.stop();
  } });
  tunnel = run.tunnel;
  const stopping = tunnel.stop();
  assert.equal(reentrant, stopping);
  await stopping;
  assert.deepEqual(run.children[0].kills, ['SIGTERM']);
});

test('a reconnect attempt that never acknowledges its forward times out and retries', async context => {
  clock(context);
  const run = await connected({ timeoutMs: 2000 });
  run.children[0].emit('close', 255, null);
  await flush();
  context.mock.timers.tick(1000);
  await flush();
  assert.equal(run.children.length, 2);
  context.mock.timers.tick(2000);
  await flush();
  assert.deepEqual(run.children[1].kills, ['SIGTERM']);
  assert.equal(run.tunnel.getHealth().error.code, 'SSH_TIMEOUT');
  assert.equal(run.tunnel.getHealth().retryAt - Date.now(), 2000);
  await run.tunnel.stop();
});

test('Response-shaped health results validate JSON within the same bounded probe', async () => {
  const run = await connected({ probe: async () => new Response(JSON.stringify(HEALTH),
    { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal(run.tunnel.getHealth().status, 'online');
  await run.tunnel.stop();
});

test('synchronously thrown spawn failures never leak their original details', async () => {
  const run = harness({ spawnProcess() {
    throw Object.assign(new Error('/private/identity not found'), { code: 'ENOENT' });
  } });
  await assert.rejects(run.starting, error => error.code === 'SSH_MISSING' && !error.message.includes('/private'));
});

test('checkSsh checks only the selected executable version and bounds its wait', async context => {
  clock(context);
  const child = fakeChild();
  const checking = checkSsh('/custom/ssh', 1000, (binary, args, options) => {
    assert.equal(binary, '/custom/ssh');
    assert.deepEqual(args, ['-V']);
    assert.equal(options.stdio, 'ignore');
    return child;
  });
  child.emit('close', 0, null);
  assert.deepEqual(await checking, { available: true });
  const hanging = fakeChild();
  const timed = checkSsh('ssh', 1000, () => hanging);
  context.mock.timers.tick(1000);
  assert.deepEqual(await timed, { available: false });
  assert.deepEqual(hanging.kills, ['SIGKILL']);
});
