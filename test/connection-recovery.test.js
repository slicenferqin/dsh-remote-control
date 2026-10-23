import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionCredentialRecovery } from '../src/connection-recovery.js';

const flush = async () => { for (let index = 0; index < 25; index++) await Promise.resolve(); };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeTimers() {
  let now = 0;
  let identifier = 0;
  const tasks = new Map();
  return {
    tasks,
    setTimeout(callback, delay) {
      const id = ++identifier;
      tasks.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
    async advance(delay) {
      const target = now + delay;
      let count = 0;
      while (true) {
        const next = [...tasks].filter(([, item]) => item.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        assert.ok(++count < 100, 'recovery must not create an unbounded timer loop');
        now = next[1].due;
        tasks.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}
function fixture({ initial = 'connected', refresh, reconnect, factory = createConnectionCredentialRecovery } = {}) {
  let state = initial;
  const listeners = new Set();
  const timers = fakeTimers();
  const calls = { refresh: 0, reconnect: 0, subscribe: 0, unsubscribe: 0 };
  const order = [];
  const connection = {
    state: {
      getSnapshot: () => state,
      subscribe(listener) {
        calls.subscribe++;
        listeners.add(listener);
        return () => { calls.unsubscribe++; listeners.delete(listener); };
      },
    },
    reconnect() { calls.reconnect++; order.push('reconnect'); reconnect?.(run); },
  };
  const helper = factory({ connection,
    refresh() { calls.refresh++; order.push('refresh'); return refresh ? refresh(run) : Promise.resolve({ phase: 'ready' }); },
    setTimeout: (callback, delay) => timers.setTimeout(callback, delay),
    clearTimeout: id => timers.clearTimeout(id),
  });
  const run = { helper, connection, calls, order, timers, listeners,
    setState(next, notify = true) { state = next; if (notify) this.emit(); },
    emit() { for (const listener of [...listeners]) listener(); },
  };
  return run;
}

test('connected Core stays untouched and start is idempotent', async () => {
  const run = fixture();
  run.helper.start();
  run.helper.start();
  run.emit();
  run.helper.notifyCredentialState({ phase: 'ready' });
  await run.timers.advance(60000);
  assert.equal(run.calls.subscribe, 1);
  assert.equal(run.calls.refresh, 0);
  assert.equal(run.calls.reconnect, 0);
  assert.equal(run.timers.tasks.size, 0);
  run.helper.dispose();
});

test('a connecting state that heals during the grace period never refreshes or reconnects', async () => {
  const run = fixture();
  run.helper.start();
  run.setState('connecting');
  assert.equal(run.timers.tasks.size, 1);
  await run.timers.advance(750);
  run.setState('connected');
  assert.equal(run.timers.tasks.size, 0);
  await run.timers.advance(60000);
  assert.equal(run.calls.refresh, 0);
  assert.equal(run.calls.reconnect, 0);
  run.helper.dispose();
});

test('persistent connecting refreshes after 900ms and reconnects only after ready', async () => {
  const ready = deferred();
  const run = fixture({ refresh: () => ready.promise });
  run.helper.start();
  run.setState('connecting');
  await run.timers.advance(899);
  assert.equal(run.calls.refresh, 0);
  await run.timers.advance(1);
  assert.equal(run.calls.refresh, 1);
  assert.equal(run.calls.reconnect, 0);
  ready.resolve({ phase: 'ready' });
  await flush();
  assert.deepEqual(run.order, ['refresh', 'reconnect']);
  run.helper.dispose();
});

test('starting while Core is already connecting recovers the current outage', async () => {
  const run = fixture({ initial: 'connecting' });
  run.helper.start();
  await run.timers.advance(900);
  assert.equal(run.calls.refresh, 1);
  assert.equal(run.calls.reconnect, 1);
  run.helper.dispose();
});

test('Core self-healing while refresh is pending is never interrupted by its late ready result', async () => {
  const ready = deferred();
  const run = fixture({ initial: 'connecting', refresh: () => ready.promise });
  run.helper.start();
  await run.timers.advance(900);
  run.setState('connected');
  ready.resolve({ phase: 'ready' });
  await flush();
  run.helper.notifyCredentialState({ phase: 'ready' });
  assert.equal(run.calls.reconnect, 0);
  assert.equal(run.timers.tasks.size, 0);
  run.helper.dispose();
});

test('repeated retry events merge into one request and one reconnect per outage', async () => {
  const ready = deferred();
  const run = fixture({ initial: 'connecting', refresh: () => ready.promise });
  run.helper.start();
  for (let index = 0; index < 20; index++) run.emit();
  assert.equal(run.timers.tasks.size, 1);
  await run.timers.advance(900);
  for (let index = 0; index < 20; index++) run.emit();
  await run.timers.advance(60000);
  assert.equal(run.calls.refresh, 1);
  ready.resolve({ phase: 'ready' });
  await flush();
  for (let index = 0; index < 20; index++) {
    run.emit();
    run.helper.notifyCredentialState({ phase: 'ready' });
  }
  await run.timers.advance(60000);
  assert.equal(run.calls.refresh, 1);
  assert.equal(run.calls.reconnect, 1);
  run.helper.dispose();
});

test('retrying leaves recovery pending for a later renewer ready notification without extra requests', async () => {
  const run = fixture({ initial: 'connecting', refresh: async () => ({ phase: 'retrying' }) });
  run.helper.start();
  await run.timers.advance(900);
  assert.equal(run.calls.reconnect, 0);
  run.helper.notifyCredentialState({ phase: 'retrying' });
  await run.timers.advance(120000);
  assert.equal(run.calls.refresh, 1);
  run.helper.notifyCredentialState({ phase: 'ready' });
  run.helper.notifyCredentialState({ phase: 'ready' });
  assert.equal(run.calls.reconnect, 1);
  assert.equal(run.calls.refresh, 1);
  run.helper.dispose();
});

test('a rejected refresh is contained and a later ready notification can recover once', async () => {
  const run = fixture({ initial: 'connecting', refresh: async () => { throw new Error('temporary network error'); } });
  run.helper.start();
  await run.timers.advance(900);
  assert.equal(run.calls.reconnect, 0);
  run.helper.notifyCredentialState({ phase: 'ready' });
  await run.timers.advance(60000);
  assert.equal(run.calls.refresh, 1);
  assert.equal(run.calls.reconnect, 1);
  run.helper.dispose();
});

test('expired credentials do not loop and later ready notifications cannot revive the same outage', async () => {
  const run = fixture({ initial: 'connecting', refresh: async () => ({ phase: 'expired' }) });
  run.helper.start();
  await run.timers.advance(900);
  for (let index = 0; index < 5; index++) {
    run.emit();
    run.helper.notifyCredentialState({ phase: 'ready' });
  }
  await run.timers.advance(60000);
  assert.equal(run.calls.refresh, 1);
  assert.equal(run.calls.reconnect, 0);
  assert.equal(run.timers.tasks.size, 0);
  run.helper.dispose();
});

test('synchronous reconnect publications and renewer callbacks cannot reenter recovery', async () => {
  const run = fixture({ initial: 'connecting',
    refresh: async value => {
      value.emit();
      value.helper.notifyCredentialState({ phase: 'ready' });
      return { phase: 'ready' };
    },
    reconnect(value) {
      value.setState('connecting');
      value.helper.notifyCredentialState({ phase: 'ready' });
    },
  });
  run.helper.start();
  await run.timers.advance(900);
  await run.timers.advance(60000);
  assert.equal(run.calls.refresh, 1);
  assert.equal(run.calls.reconnect, 1);
  run.helper.dispose();
});

test('disconnected and undefined states never force a refresh or reconnect', async () => {
  for (const initial of ['disconnected', undefined]) {
    const run = fixture({ initial });
    if (initial === undefined) run.setState(undefined, false);
    run.helper.start();
    await run.timers.advance(60000);
    assert.equal(run.calls.refresh, 0);
    assert.equal(run.calls.reconnect, 0);
    run.helper.dispose();
  }
});

test('a ready result while disconnected waits until Core returns to connecting', async () => {
  const ready = deferred();
  const run = fixture({ initial: 'connecting', refresh: () => ready.promise });
  run.helper.start();
  await run.timers.advance(900);
  run.setState('disconnected');
  ready.resolve({ phase: 'ready' });
  await flush();
  assert.equal(run.calls.reconnect, 0);
  run.setState('connecting');
  assert.equal(run.calls.reconnect, 1);
  assert.equal(run.calls.refresh, 1);
  run.helper.dispose();
});

test('a genuine new outage after connected gets a new bounded recovery attempt', async () => {
  const run = fixture({ initial: 'connecting' });
  run.helper.start();
  await run.timers.advance(900);
  run.setState('connected');
  run.setState('connecting');
  await run.timers.advance(900);
  assert.equal(run.calls.refresh, 2);
  assert.equal(run.calls.reconnect, 2);
  run.helper.dispose();
});

test('a new outage cannot overlap an older in-flight refresh or use its stale result', async () => {
  const old = deferred();
  const run = fixture({ initial: 'connecting', refresh: value => value.calls.refresh === 1 ? old.promise : Promise.resolve({ phase: 'ready' }) });
  run.helper.start();
  await run.timers.advance(900);
  run.setState('connected');
  run.setState('connecting');
  await run.timers.advance(900);
  assert.equal(run.calls.refresh, 1);
  old.resolve({ phase: 'ready' });
  await flush();
  assert.equal(run.calls.reconnect, 0);
  await run.timers.advance(900);
  assert.equal(run.calls.refresh, 2);
  assert.equal(run.calls.reconnect, 1);
  run.helper.dispose();
});

test('dispose removes the listener, cancels grace timers, and is terminal', async () => {
  const run = fixture({ initial: 'connecting' });
  run.helper.start();
  assert.equal(run.listeners.size, 1);
  run.helper.dispose();
  run.helper.dispose();
  run.helper.start();
  run.helper.notifyCredentialState({ phase: 'ready' });
  await run.timers.advance(60000);
  assert.equal(run.listeners.size, 0);
  assert.equal(run.calls.unsubscribe, 1);
  assert.equal(run.calls.refresh, 0);
  assert.equal(run.calls.reconnect, 0);
});

test('dispose ignores an in-flight refresh result and future renewer notifications', async () => {
  const ready = deferred();
  const run = fixture({ initial: 'connecting', refresh: () => ready.promise });
  run.helper.start();
  await run.timers.advance(900);
  run.helper.dispose();
  ready.resolve({ phase: 'ready' });
  run.helper.notifyCredentialState({ phase: 'ready' });
  await flush();
  await run.timers.advance(60000);
  assert.equal(run.calls.refresh, 1);
  assert.equal(run.calls.reconnect, 0);
  assert.equal(run.listeners.size, 0);
  assert.equal(run.timers.tasks.size, 0);
});

test('Core disconnecting before the refresh microtask does not consume its only recovery attempt', async () => {
  const run = fixture({ initial: 'connecting' });
  run.helper.start();
  const [id, timer] = [...run.timers.tasks][0];
  run.timers.tasks.delete(id);
  timer.callback();
  run.setState('disconnected');
  await flush();
  assert.equal(run.calls.refresh, 0);
  run.setState('connecting');
  await run.timers.advance(900);
  assert.equal(run.calls.refresh, 1);
  assert.equal(run.calls.reconnect, 1);
  run.helper.dispose();
});

test('dispose between the timer callback and refresh microtask prevents the refresh call', async () => {
  const run = fixture({ initial: 'connecting' });
  run.helper.start();
  const [id, timer] = [...run.timers.tasks][0];
  run.timers.tasks.delete(id);
  timer.callback();
  run.helper.dispose();
  await flush();
  assert.equal(run.calls.refresh, 0);
  assert.equal(run.calls.reconnect, 0);
  assert.equal(run.listeners.size, 0);
  assert.equal(run.timers.tasks.size, 0);
});

test('an expired notification wins over a later ready result from the pending refresh', async () => {
  const ready = deferred();
  const run = fixture({ initial: 'connecting', refresh: () => ready.promise });
  run.helper.start();
  await run.timers.advance(900);
  run.helper.notifyCredentialState({ phase: 'expired' });
  ready.resolve({ phase: 'ready' });
  await flush();
  run.helper.notifyCredentialState({ phase: 'ready' });
  await run.timers.advance(60000);
  assert.equal(run.calls.refresh, 1);
  assert.equal(run.calls.reconnect, 0);
  run.helper.dispose();
});

test('the serialized factory runs independently without module closures or imports', async () => {
  const factory = (0, eval)(`(${createConnectionCredentialRecovery.toString()})`);
  const run = fixture({ initial: 'connecting', factory });
  run.helper.start();
  await run.timers.advance(900);
  assert.equal(run.calls.refresh, 1);
  assert.equal(run.calls.reconnect, 1);
  run.helper.dispose();
});
