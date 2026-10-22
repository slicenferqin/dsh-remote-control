import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startQuickTunnel, RemoteControlError } from '../src/tunnel.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('close', 0, signal)); return true; };
  return child;
}
function launch(child, extra = {}) {
  return startQuickTunnel({ binary: 'cloudflared', origin: 'http://127.0.0.1:45678', timeoutMs: 10000,
    protocol: 'http2', spawnProcess: () => child, ...extra });
}
function ready(child) {
  child.stderr.write('https://fixture.trycloudflare.com\n');
  child.stderr.write('{"message":"Registered tunnel connection connIndex=0"}\n');
}

test('a URL alone is not readiness; an edge connection completes startup', async () => {
  const child = fakeChild();
  let resolved = false;
  const starting = launch(child).then(value => { resolved = true; return value; });
  child.stderr.write('https://fixture.trycloudflare.com\n');
  await Promise.resolve();
  assert.equal(resolved, false);
  child.stderr.write('{"message":"Registered tunnel connection"}\n');
  const tunnel = await starting;
  assert.equal(tunnel.publicUrl, 'https://fixture.trycloudflare.com');
  await tunnel.stop();
  await tunnel.stop();
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('abort during startup terminates the owned child', async () => {
  const child = fakeChild();
  const abort = new AbortController();
  const starting = launch(child, { signal: abort.signal });
  abort.abort();
  await assert.rejects(starting, { code: 'CANCELLED' });
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('a spawn error is an actionable missing-dependency failure', async () => {
  const child = fakeChild();
  const starting = launch(child);
  child.emit('error', Object.assign(new Error('private process details'), { code: 'ENOENT' }));
  await assert.rejects(starting, error => error instanceof RemoteControlError
    && error.code === 'CLOUDFLARED_MISSING' && !error.message.includes('private'));
});

test('unrelated HTTPS URLs cannot become the remote origin', async () => {
  const child = fakeChild();
  const starting = launch(child);
  child.stderr.write('https://attacker.example.com\nRegistered tunnel connection\n');
  child.emit('close', 1, null);
  await assert.rejects(starting, { code: 'TUNNEL_EXITED' });
});

test('unexpected exit after readiness notifies the owner', async () => {
  const child = fakeChild();
  let failure;
  const starting = launch(child, { onExit: error => { failure = error; } });
  ready(child);
  const tunnel = await starting;
  child.emit('close', 2, null);
  assert.equal(failure.code, 'TUNNEL_EXITED');
  await tunnel.stop();
});

test('pre-aborted startup allocates no subprocess', async () => {
  const abort = new AbortController();
  abort.abort();
  let spawned = false;
  await assert.rejects(startQuickTunnel({ signal: abort.signal, spawnProcess() { spawned = true; } }), { code: 'CANCELLED' });
  assert.equal(spawned, false);
});
