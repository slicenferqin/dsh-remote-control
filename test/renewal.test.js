import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCredentialRenewer } from '../src/renewal.js';

const device = (overrides = {}) => ({
  id: 'phone-1', label: 'My phone', pairedAt: 1, expiresAt: 8 * 60 * 60 * 1000,
  refreshExpiresAt: 10 * 24 * 60 * 60 * 1000, serverTime: 1000,
  refreshAfterMs: 1000, refreshRetryMs: 2500, ...overrides,
});
const response = (value = device(), status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function flush() { for (let index = 0; index < 16; index++) await Promise.resolve(); }

function clock() {
  let time = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    delays() { return [...timers.values()].map(timer => timer.at - time).sort((a, b) => a - b); },
    async advance(delta) {
      const end = time + delta;
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, timer] = entry;
        time = timer.at;
        timers.delete(id);
        timer.callback();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}
class BrowserEvents extends EventTarget {
  listeners = new Map();
  addEventListener(type, listener, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener, options) {
    this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  get listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
  emit(type) { this.dispatchEvent(new Event(type)); }
}
function fixture(t, initial = device(), options = {}) {
  const time = clock();
  const window = new BrowserEvents();
  const document = new BrowserEvents();
  document.visibilityState = 'visible';
  const requests = [];
  const states = [];
  const replies = [];
  const renewer = createCredentialRenewer({
    fetch(url, options) {
      requests.push({ url, options });
      const reply = replies.shift();
      return reply ? reply(url, options) : response(initial);
    },
    ...time, window, document, ...options, onState: state => states.push(state),
  });
  t.after(() => renewer.dispose());
  return { renewer, time, window, document, requests, states, replies, latest: () => states.at(-1) };
}

test('initial GET schedules the server delay independently of the browser wall clock', async t => {
  const f = fixture(t, device({ expiresAt: 2, refreshExpiresAt: 3, serverTime: 1, refreshAfterMs: 1000 }));
  const started = f.renewer.start();
  assert.strictEqual(f.renewer.start(), started);
  await started;
  assert.equal(f.requests[0].url, '/__dsh_remote_device');
  assert.equal(f.requests[0].options.method, 'GET');
  assert.equal(f.requests[0].options.credentials, 'same-origin');
  assert.equal(f.requests[0].options.cache, 'no-store');
  assert.equal(f.requests[0].options.redirect, 'error');
  assert.equal(f.requests[0].options.body, undefined);
  assert.deepEqual(f.time.delays(), [1000]);
  await f.time.advance(999);
  assert.equal(f.requests.length, 1);
  f.replies.push(() => response(device({ refreshAfterMs: 7000 })));
  await f.time.advance(1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].url, '/__dsh_remote_refresh');
  assert.equal(f.requests[1].options.method, 'POST');
  assert.equal(f.requests[1].options.body, '{}');
  assert.deepEqual(f.requests[1].options.headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
  assert.deepEqual(f.time.delays(), [7000]);
  assert.equal(f.latest().phase, 'ready');
});

test('refresh and wake events share one promise and leave one scheduling timer', async t => {
  const f = fixture(t);
  await f.renewer.start();
  const gate = deferred();
  f.replies.push(() => gate.promise);
  const first = f.renewer.refresh();
  assert.strictEqual(first, f.renewer.refresh());
  f.window.emit('online');
  f.window.emit('pageshow');
  f.document.emit('visibilitychange');
  await flush();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.time.delays(), [30_000]);
  gate.resolve(response(device({ refreshAfterMs: 1500 })));
  await first;
  assert.deepEqual(f.time.delays(), [1500]);
  await f.time.advance(1000);
  assert.equal(f.requests.length, 2);
  await f.time.advance(500);
  assert.equal(f.requests.length, 3);
});

test('hidden timers wait and visible, online, and pageshow events renew immediately', async t => {
  const f = fixture(t);
  await f.renewer.start();
  f.document.visibilityState = 'hidden';
  f.document.emit('visibilitychange');
  await f.time.advance(1000);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.time.delays(), []);
  f.document.visibilityState = 'visible';
  f.document.emit('visibilitychange');
  await flush();
  assert.equal(f.requests.length, 2);
  for (const type of ['online', 'pageshow']) {
    f.window.emit(type);
    await flush();
  }
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.time.delays(), [1000]);
});

for (const status of [401, 403]) {
  for (const atStartup of [true, false]) {
    test(`${status} during ${atStartup ? 'startup' : 'refresh'} stops timers and all event recovery`, async t => {
      const f = fixture(t);
      if (!atStartup) await f.renewer.start();
      f.replies.push(() => response(null, status));
      await (atStartup ? f.renewer.start() : f.renewer.refresh());
      assert.equal(f.latest().phase, 'expired');
      assert.deepEqual(f.latest().error, { code: 'credentials_expired', status });
      assert.equal(f.latest().device, null);
      assert.deepEqual(f.time.delays(), []);
      assert.equal(f.window.listenerCount + f.document.listenerCount, 0);
      const count = f.requests.length;
      f.window.emit('online');
      f.window.emit('pageshow');
      f.document.emit('visibilitychange');
      await f.renewer.refresh();
      await f.renewer.start();
      await f.time.advance(100_000);
      assert.equal(f.requests.length, count);
      assert.equal(f.latest().phase, 'expired');
    });
  }
}

for (const kind of ['network', '5xx', 'invalid-json', 'invalid-metadata']) {
  test(`${kind} retries using the last server refreshRetryMs and recovers`, async t => {
    const f = fixture(t, device({ refreshRetryMs: 4000 }));
    await f.renewer.start();
    const previous = f.latest().device;
    f.replies.push(() => {
      if (kind === 'network') throw new TypeError('Disconnected');
      if (kind === '5xx') return response(null, 503);
      if (kind === 'invalid-json') return { ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } };
      return response({ refreshAfterMs: 1 });
    });
    await f.renewer.refresh();
    assert.equal(f.latest().phase, 'retrying');
    assert.strictEqual(f.latest().device, previous);
    assert.deepEqual(f.time.delays(), [4000]);
    await f.time.advance(3999);
    assert.equal(f.requests.length, 2);
    await f.time.advance(1);
    assert.equal(f.requests.length, 3);
    assert.equal(f.latest().phase, 'ready');
    assert.deepEqual(f.time.delays(), [1000]);
  });
}

test('a failed first metadata read retries with a bounded default before server timing is available', async t => {
  const f = fixture(t);
  f.replies.push(() => response(null, 502));
  await f.renewer.start();
  assert.equal(f.latest().phase, 'retrying');
  assert.deepEqual(f.time.delays(), [30_000]);
  await f.time.advance(30_000);
  assert.equal(f.requests[1].options.method, 'POST');
  assert.equal(f.latest().phase, 'ready');
});

for (const hangAt of ['fetch', 'json']) {
  test(`30s timeout aborts a hung ${hangAt} and ignores its late result`, async t => {
    const f = fixture(t);
    await f.renewer.start();
    const gate = deferred();
    f.replies.push(() => hangAt === 'fetch' ? gate.promise : { ok: true, json: () => gate.promise });
    const pending = f.renewer.refresh();
    await flush();
    const signal = f.requests[1].options.signal;
    await f.time.advance(29_999);
    assert.equal(signal.aborted, false);
    await f.time.advance(1);
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(f.latest().error.code, 'request_timeout');
    assert.deepEqual(f.time.delays(), [2500]);
    const count = f.states.length;
    gate.resolve(hangAt === 'fetch' ? response(null, 401) : device({ refreshAfterMs: 1 }));
    await flush();
    assert.equal(f.states.length, count);
    assert.equal(f.latest().phase, 'retrying');
    await f.time.advance(2500);
    assert.equal(f.latest().phase, 'ready');
  });
}

test('dispose aborts pending work, clears listeners/timers, and ignores late success', async t => {
  const f = fixture(t);
  await f.renewer.start();
  const gate = deferred();
  f.replies.push(() => gate.promise);
  const pending = f.renewer.refresh();
  await flush();
  const signal = f.requests[1].options.signal;
  const count = f.states.length;
  f.renewer.dispose();
  f.renewer.dispose();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(f.window.listenerCount + f.document.listenerCount, 0);
  assert.deepEqual(f.time.delays(), []);
  gate.resolve(response(device({ refreshAfterMs: 1 })));
  f.window.emit('online');
  f.window.emit('pageshow');
  f.document.emit('visibilitychange');
  await f.renewer.refresh();
  await f.renewer.start();
  await f.time.advance(100_000);
  assert.equal(f.states.length, count);
  assert.equal(f.requests.length, 2);
});

test('disposing before the request microtask never sends a request or publishes state', async t => {
  const f = fixture(t);
  const pending = f.renewer.start();
  f.renewer.dispose();
  await pending;
  assert.equal(f.requests.length, 0);
  assert.equal(f.states.length, 0);
  assert.deepEqual(f.time.delays(), []);
});

test('only documented metadata reaches state', async t => {
  const f = fixture(t, { ...device(), accessToken: 'must-not-be-copied', refreshToken: 'must-not-be-copied' });
  await f.renewer.start();
  assert.deepEqual(f.latest().device, device());
});

test('zero server delay schedules one second ahead instead of a busy loop', async t => {
  const f = fixture(t, device({ refreshAfterMs: 0 }));
  await f.renewer.start();
  assert.deepEqual(f.time.delays(), [1000]);
  await f.time.advance(999);
  assert.equal(f.requests.length, 1);
  await f.time.advance(1);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.time.delays(), [1000]);
});

function lockManager() {
  let tail = Promise.resolve();
  let active = 0;
  let maximum = 0;
  const calls = [];
  return {
    calls,
    get active() { return active; },
    get maximum() { return maximum; },
    request(name, options, callback) {
      calls.push({ name, options });
      const pending = tail.then(async () => {
        if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        active++;
        maximum = Math.max(maximum, active);
        try { return await callback(); } finally { active--; }
      });
      tail = pending.catch(() => {});
      return pending;
    },
  };
}

test('same-origin tabs serialize POST exchanges with Web Locks and release before retry timers', async t => {
  const locks = lockManager();
  const a = fixture(t, device(), { locks });
  const b = fixture(t, device(), { locks });
  await Promise.all([a.renewer.start(), b.renewer.start()]);
  assert.equal(locks.calls.length, 0);
  const first = deferred();
  const second = deferred();
  a.replies.push(() => first.promise);
  b.replies.push(() => second.promise);
  const pendingA = a.renewer.refresh();
  const pendingB = b.renewer.refresh();
  await flush();
  assert.equal(a.requests.length, 2);
  assert.equal(b.requests.length, 1);
  assert.equal(locks.active, 1);
  first.resolve(response(null, 503));
  await pendingA;
  await flush();
  assert.equal(a.latest().phase, 'retrying');
  assert.deepEqual(a.time.delays(), [2500]);
  assert.equal(b.requests.length, 2);
  second.resolve(response());
  await pendingB;
  assert.equal(locks.active, 0);
  assert.equal(locks.maximum, 1);
  assert.equal(locks.calls.length, 2);
  for (const { name, options } of locks.calls) {
    assert.equal(name, 'dsh-remote-control.credentials');
    assert.equal(options.mode, 'exclusive');
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('disposing a tab waiting for a Web Lock prevents its queued POST', async t => {
  const locks = lockManager();
  const a = fixture(t, device(), { locks });
  const b = fixture(t, device(), { locks });
  await Promise.all([a.renewer.start(), b.renewer.start()]);
  const gate = deferred();
  a.replies.push(() => gate.promise);
  const pendingA = a.renewer.refresh();
  const pendingB = b.renewer.refresh();
  await flush();
  b.renewer.dispose();
  await pendingB;
  assert.equal(locks.calls[1].options.signal.aborted, true);
  gate.resolve(response());
  await pendingA;
  await flush();
  assert.equal(b.requests.length, 1);
  assert.deepEqual(b.time.delays(), []);
  assert.equal(locks.active, 0);
});

test('client enables renewal only on HTTPS Quick Tunnel origins and renders expired credentials at the root', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let factory;
  try {
    globalThis.window = { __ModuleLoader__: { load(module) { factory = module.factory; } } };
    await import('../client.js');
    const origins = [
      ['http://127.0.0.1:3080', false], ['https://localhost', false],
      ['http://phone.trycloudflare.com', false], ['https://trycloudflare.com', false],
      ['https://nested.phone.trycloudflare.com', false], ['https://phone.trycloudflare.com.evil.test', false],
      ['https://phone.trycloudflare.com:8443', false], ['https://phone.trycloudflare.com', true],
      ['https://phone-with-hyphens.trycloudflare.com', true],
    ];
    for (const [origin, enabled] of origins) {
      for (const status of enabled ? [200, 401, 403] : [200]) {
        const browser = new BrowserEvents();
        const document = new BrowserEvents();
        document.visibilityState = 'visible';
        Object.defineProperty(document, 'cookie', { get() { throw new Error('Credentials must remain HttpOnly'); } });
        Object.defineProperty(browser, 'localStorage', { get() { throw new Error('Credentials must not use localStorage'); } });
        browser.location = new URL(origin);
        const requests = [];
        browser.fetch = (url, options) => { requests.push({ url, options }); return response(device(), status); };
        globalThis.window = browser;
        globalThis.document = document;
        const entries = [];
        const cleanup = [];
        const React = {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useSyncExternalStore: (subscribe, snapshot) => snapshot(),
        };
        const plugin = factory(name => { assert.equal(name, 'react'); return React; });
        const locale = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'));
        plugin.apply({
          effect(callback) { const dispose = callback(); cleanup.push(dispose); return dispose; },
          locale: {
            register: () => () => {}, bind: () => key => locale.ui[key],
            subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh' }),
          },
          slots: {
            inject(name, callback) { return callback(); },
            register(options, component) { entries.push({ options, component }); return () => {}; },
          },
        });
        try {
          await flush();
          assert.equal(requests.length, enabled ? 1 : 0, origin);
          const overlay = entries.find(entry => entry.options.id === 'dsh-remote-control.credentials');
          assert.equal(Boolean(overlay), enabled, origin);
          if (enabled) {
            assert.equal(overlay.options.name, 'shell.overlay');
            const notice = overlay.component();
            if (status === 200) assert.equal(notice, null);
            else {
              assert.equal(notice.props.role, 'alert');
              assert.equal(notice.children[0], '设备已过期或被撤销，请重新配对。');
              assert.equal(browser.listenerCount + document.listenerCount, 0);
            }
          }
        } finally {
          for (const dispose of cleanup.reverse()) if (typeof dispose === 'function') dispose();
        }
      }
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;
  }
});

test('the committed client embeds the same self-contained helper and localized messages', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const begin = '    // BEGIN GENERATED CREDENTIAL RENEWER';
  const end = '    // END GENERATED CREDENTIAL RENEWER';
  const block = source.slice(source.indexOf(begin), source.indexOf(end));
  const helper = createCredentialRenewer.toString().split('\n').map(line => line ? `    ${line}` : '').join('\n');
  assert.ok(block.includes(helper));
  const dictionaries = JSON.parse(source.slice(source.indexOf('const DICTIONARIES = ') + 'const DICTIONARIES = '.length, source.indexOf('};\n    const CSS')) + '}');
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(await readFile(new URL(`../locale/${language}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(dictionaries[language], locale.ui);
  }
});
