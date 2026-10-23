import test from 'node:test'
import assert from 'node:assert/strict'
import { createPairingResumer } from '../src/pairing-resume.js'

const metadata = overrides => ({ id: 'fixture-device', expiresAt: 9000, refreshExpiresAt: 99000, serverTime: 1000, ...overrides })
const response = (value = metadata(), status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function flush() { for (let index = 0; index < 24; index++) await Promise.resolve() }
function fixture() {
  const requests = [], states = [], navigations = [], replies = [], timers = new Map()
  let sequence = 0
  const resumer = createPairingResumer({
    fetch(path, options) { requests.push({ path, options }); const reply = replies.shift(); return reply ? reply() : response() },
    location: { pathname: '/__dsh_remote_pair', search: '?return=https://untrusted.invalid/', replace: path => navigations.push(path) },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) }, onState: state => states.push(state),
  })
  return { resumer, requests, states, navigations, replies, timers, latest: () => states.at(-1) }
}

test('recovery confirms browser cookies after POST before navigating once to the fixed root', async () => {
  const f = fixture(), refreshed = deferred(), confirmed = deferred()
  f.replies.push(() => refreshed.promise, () => confirmed.promise)
  const pending = f.resumer.start()
  assert.strictEqual(f.resumer.start(), pending)
  assert.strictEqual(f.resumer.retry(), pending)
  await flush()
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.navigations, [])
  assert.equal(f.requests[0].path, '/__dsh_remote_refresh')
  assert.equal(f.requests[0].options.method, 'POST')
  assert.equal(f.requests[0].options.body, '{}')
  refreshed.resolve(response())
  await flush()
  assert.equal(f.requests[1].path, '/__dsh_remote_device')
  assert.equal(f.requests[1].options.method, 'GET')
  assert.equal(f.requests[1].options.body, undefined)
  assert.equal(f.requests[1].options.headers['X-DSH-Remote-Confirm'], '1')
  assert.deepEqual(f.navigations, [])
  confirmed.resolve(response())
  await pending
  assert.deepEqual(f.navigations, ['/'])
  assert.equal(f.latest().phase, 'ready')
  for (const { options } of f.requests) {
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
  }
  await f.resumer.start(); await f.resumer.retry()
  assert.equal(f.requests.length, 2)
  assert.equal(f.timers.size, 0)
})

for (const status of [401, 403, 502]) {
  test(`${status} stays on the page without automatic retry and allows explicit retry`, async () => {
    const f = fixture()
    f.replies.push(() => response(null, status))
    await f.resumer.start()
    assert.equal(f.latest().error, status === 502 ? 'network_error' : 'credentials_required')
    assert.deepEqual(f.navigations, [])
    assert.equal(f.timers.size, 0)
    await f.resumer.start(); await flush()
    assert.equal(f.requests.length, 1)
    await f.resumer.retry()
    assert.deepEqual(f.navigations, ['/'])
  })
}

for (const value of [metadata({ expiresAt: 1000 }), metadata({ refreshExpiresAt: 1000 }), metadata({ serverTime: NaN }), {}, null]) {
  test(`invalid or expired metadata prevents navigation: ${JSON.stringify(value)}`, async () => {
    const f = fixture()
    f.replies.push(() => response(value))
    await f.resumer.start()
    assert.equal(f.latest().phase, 'failed')
    assert.deepEqual(f.navigations, [])
    assert.equal(f.requests.length, 1)
  })
}

test('successful refresh without browser cookie application does not navigate', async () => {
  const f = fixture()
  f.replies.push(() => response(), () => response(null, 401))
  await f.resumer.start()
  assert.equal(f.requests.length, 2)
  assert.equal(f.latest().error, 'credentials_required')
  assert.deepEqual(f.navigations, [])
})

test('device identity must agree across the refresh and confirmation responses', async () => {
  const f = fixture()
  f.replies.push(() => response(), () => response(metadata({ id: 'another-device' })))
  await f.resumer.start()
  assert.equal(f.latest().error, 'invalid_response')
  assert.deepEqual(f.navigations, [])
})

for (const kind of ['network', 'non-json']) {
  test(`${kind} errors publish fixed codes without exposing exception text`, async () => {
    const f = fixture()
    f.replies.push(() => {
      if (kind === 'network') throw new Error('private-fixture-error')
      return { ok: true, json: async () => { throw new Error('private-fixture-error') } }
    })
    await f.resumer.start()
    assert.equal(f.latest().phase, 'failed')
    assert.equal(JSON.stringify(f.states).includes('private-fixture-error'), false)
    assert.deepEqual(f.navigations, [])
  })
}

for (const hangAt of ['post', 'json', 'get']) {
  test(`30s total timeout handles hung ${hangAt}, ignores late completion, and permits retry`, async () => {
    const f = fixture(), gate = deferred()
    if (hangAt === 'get') f.replies.push(() => response())
    f.replies.push(() => hangAt === 'json' ? { ok: true, json: () => gate.promise } : gate.promise)
    const pending = f.resumer.start()
    await flush()
    const timer = [...f.timers.values()][0]
    assert.equal(timer.delay, 30_000)
    timer.callback()
    await pending
    assert.equal(f.latest().error, 'request_timeout')
    assert.equal(f.requests.at(-1).options.signal.aborted, true)
    gate.resolve(hangAt === 'json' ? metadata() : response())
    await flush()
    assert.deepEqual(f.navigations, [])
    await f.resumer.retry()
    assert.deepEqual(f.navigations, ['/'])
    assert.equal(f.timers.size, 0)
  })
}
