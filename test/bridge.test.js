import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { once, EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { createRemoteBridge } from '../src/bridge.js'

const PUBLIC = 'https://amber-quiet-river-cloud.trycloudflare.com'
const HOST = new URL(PUBLIC).host
const PAIR_PATH = '/__dsh_remote_pair'
const AUTH = 'dsh-auth-test=signed-internal-cookie'
const GATE = '__Host-dsh-remote-device'
const LAUNCH = 'test-launch-secret-never-public'
const REFRESH_PATH = '/__dsh_remote_refresh'
const REFRESH_GATE = '__Host-dsh-remote-refresh'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function refresh(bridge, cookie, extra = {}) {
  return request(bridge.origin, REFRESH_PATH, {
    method: extra.method ?? 'POST',
    headers: { cookie, 'content-type': 'application/json', ...extra.headers },
    body: extra.body ?? '{}',
  })
}

function onlyCookie(cookie, name) {
  return cookie.split('; ').find(value => value.startsWith(`${name}=`))
}

function request(origin, path = '/', { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const cleanHeaders = Object.fromEntries(Object.entries({ host: HOST, origin: PUBLIC, ...headers }).filter(([, value]) => value !== undefined))
    const req = http.request(origin, { path, method, agent: false, headers: cleanHeaders }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function secretOf(pairing) {
  const url = new URL(pairing.url)
  assert.equal(url.search, '')
  return new URLSearchParams(url.hash.slice(1)).get('secret')
}

function redeem(bridge, pairing, label = 'My phone', extra = {}) {
  return request(bridge.origin, PAIR_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extra.headers },
    body: JSON.stringify({ secret: secretOf(pairing), label }),
  })
}

function pairingBrowser(html, pairing, userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)') {
  let automaticSubmissions = 0
  const makeElement = () => ({
    value: '', disabled: true, textContent: '', validityMessage: '', listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener },
    setCustomValidity(message) { this.validityMessage = message },
    reportValidity() { return !this.validityMessage },
  })
  const elements = Object.fromEntries(['secret', 'label', 'pair', 'status'].map(id => [id, makeElement()]))
  const form = makeElement()
  form.requestSubmit = form.submit = () => { automaticSubmissions++ }
  const location = new URL(pairing.url)
  const replacements = []
  runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1], {
    URLSearchParams, location, navigator: { userAgent },
    history: { replaceState: (...args) => replacements.push(args) },
    document: { querySelector: () => form, getElementById: id => elements[id] },
  })
  return {
    elements, replacements, get automaticSubmissions() { return automaticSubmissions },
    clickPair() {
      if (elements.pair.disabled) return false
      let prevented = false
      form.listeners.submit({ preventDefault: () => { prevented = true } })
      return !prevented
    },
  }
}

function cookieHeader(response) {
  return response.headers['set-cookie'].map(cookie => cookie.split(';')[0]).join('; ')
}

async function pair(bridge, path = '/') {
  const response = await redeem(bridge, bridge.pairing(path))
  assert.equal(response.status, 303)
  return cookieHeader(response)
}

function upgraded(origin, { cookie, path = '/ws', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(origin, {
      path,
      agent: false,
      headers: Object.fromEntries(Object.entries({
        host: HOST,
        origin: PUBLIC,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
        cookie,
        ...headers,
      }).filter(([, value]) => value !== undefined)),
    })
    req.on('error', reject)
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode }) })
    req.on('upgrade', (res, socket, head) => {
      socket.on('error', () => { /* A test intentionally revokes and closes sockets. */ })
      if (head.length) socket.unshift(head)
      resolve({ status: res.statusCode, socket })
    })
    req.end()
  })
}

function maskedText(value) {
  const text = Buffer.from(value)
  const mask = Buffer.from([1, 2, 3, 4])
  const frame = Buffer.alloc(6 + text.length)
  frame[0] = 0x81
  frame[1] = 0x80 | text.length
  mask.copy(frame, 2)
  for (let index = 0; index < text.length; index++) frame[index + 6] = text[index] ^ mask[index % 4]
  return frame
}

function stream(origin, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.get(origin, { path: '/events', agent: false, headers: { host: HOST, origin: PUBLIC, cookie } }, res => {
      res.on('error', () => { /* Revocation deliberately aborts the response stream. */ })
      res.once('data', data => resolve({ req, res, data: data.toString() }))
    })
    req.on('error', reject)
  })
}

async function fixture(t, options = {}) {
  const sockets = new Set()
  const events = new EventEmitter()
  const seen = []
  const sse = []
  const state = { exchanges: 0, hangExchange: false, exchangeStatus: 303, auth: AUTH, rotateAuth: false,
    pendingExchanges: [], upstreamCookies: [], holdResponses: false, pendingResponses: [] }
  let target
  function trusted(req) {
    return req.headers.host === new URL(target).host
      && (!req.headers.origin || req.headers.origin === target)
      && req.headers.cookie?.split(';').some(value => value.trim() === state.auth)
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, target)
    if (url.pathname === '/' && url.searchParams.get('token') === LAUNCH) {
      state.exchanges++
      if (state.rotateAuth) state.auth = `dsh-auth-test=signed-cookie-${state.exchanges}`
      if (state.hangExchange) state.pendingExchanges.push(res)
      events.emit('exchange', req)
      if (state.hangExchange) return
      res.writeHead(state.exchangeStatus, {
        location: './',
        'set-cookie': `${state.auth}; Domain=127.0.0.1; Path=/; Max-Age=86400; SameSite=Lax`,
      })
      res.end('local response must not leak')
      return
    }
    if (!trusted(req)) { res.writeHead(401); res.end('upstream authentication required'); return }
    seen.push({ url: req.url, headers: req.headers })
    if (url.pathname === '/events') {
      sse.push(res)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: hello\n\n')
      return
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: `${target}/sessions/abc`, 'set-cookie': `${AUTH}; Domain=127.0.0.1; Path=/; SameSite=Lax` })
      res.end()
      return
    }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const complete = () => {
        res.writeHead(200, { 'content-type': 'application/json', ...(state.upstreamCookies.length ? { 'set-cookie': state.upstreamCookies } : {}) })
        res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }))
      }
      if (state.holdResponses) { state.pendingResponses.push(complete); events.emit('business'); return }
      complete()
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket) => {
    if (!trusted(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return }
    seen.push({ url: req.url, headers: req.headers })
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('data', frame => {
      const length = frame[1] & 127
      const payload = Buffer.alloc(length)
      for (let index = 0; index < length; index++) payload[index] = frame[index + 6] ^ frame[2 + index % 4]
      socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]))
    })
    socket.on('error', () => { /* The bridge deliberately destroys the upstream peer. */ })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  target = `http://127.0.0.1:${server.address().port}`
  const bridge = await createRemoteBridge({
    target,
    authenticatedUrl: base => { const url = new URL(base); url.searchParams.set('token', LAUNCH); return url.href },
    ...options,
  })
  bridge.setExternalOrigin(PUBLIC)
  t.after(async () => {
    await bridge.close()
    const closing = new Promise(resolve => server.close(resolve))
    for (const socket of sockets) socket.destroy()
    await closing
  })
  return { bridge, target, state, seen, sse, events, sockets }
}

test('restricts public origins and redirect paths and binds only to loopback', { timeout: 5000 }, async t => {
  const { bridge, target } = await fixture(t)
  assert.equal(new URL(bridge.origin).hostname, '127.0.0.1')
  for (const origin of ['http://amber-quiet.trycloudflare.com', 'https://trycloudflare.com', 'https://evil.example',
    'https://a.trycloudflare.com.evil.example', 'https://a.b.trycloudflare.com', 'https://user@a.trycloudflare.com',
    'https://a.trycloudflare.com:444', 'https://a.trycloudflare.com/path', 'https://a.trycloudflare.com?token=x']) {
    assert.throws(() => bridge.setExternalOrigin(origin), /Quick Tunnel/)
  }
  assert.equal(bridge.snapshot().externalOrigin, PUBLIC)
  for (const path of ['https://evil.example', '//evil.example', '/api/dsh-remote-control', '/%63onnect', '/?token=abc', '/a\r\nb']) {
    assert.throws(() => bridge.pairing(path))
  }
  await assert.rejects(createRemoteBridge({ target: 'https://evil.example', authenticatedUrl: x => x }), /loopback/)
  await assert.rejects(createRemoteBridge({ target, authenticatedUrl: x => x, pairingTtlMs: 0 }), /pairingTtlMs/)
})

test('GET previews do not consume a fragment secret; concurrent POST can redeem once', { timeout: 5000 }, async t => {
  const changes = []
  const { bridge, state } = await fixture(t, { onChange: state => changes.push(state) })
  const pairing = bridge.pairing('/sessions/abc?view=chat')
  const secret = secretOf(pairing)
  assert.equal(bridge.snapshot().pairingExpiresAt, pairing.expiresAt)
  const preview = await request(bridge.origin, PAIR_PATH, { headers: { origin: undefined } })
  assert.equal(preview.status, 200)
  assert.equal(preview.headers['set-cookie'], undefined)
  assert.match(preview.headers['content-security-policy'], /form-action 'self'/)
  assert.equal(preview.body.includes(secret), false)
  assert.doesNotMatch(preview.body, /requestSubmit\(|\.submit\(/)
  assert.equal(preview.headers['referrer-policy'], 'same-origin')
  assert.match(preview.body, /name="label" required minlength="1" maxlength="80"/)
  assert.match(preview.body, /type="submit" disabled>配对并进入/)
  assert.match(preview.body, /navigator\.userAgent/)
  assert.match(preview.body, /history\.replaceState/)
  assert.equal(state.exchanges, 0)
  assert.equal(bridge.snapshot().pairingExpiresAt, pairing.expiresAt)
  const responses = await Promise.all([redeem(bridge, pairing, '  Phone '), redeem(bridge, pairing, '  Phone ')])
  assert.deepEqual(responses.map(response => response.status).sort(), [303, 401])
  const success = responses.find(response => response.status === 303)
  assert.equal(success.headers.location, '/sessions/abc?view=chat')
  assert.equal(state.exchanges, 1)
  assert.equal(bridge.snapshot().pairingExpiresAt, null)
  assert.equal(bridge.snapshot().devices[0].label, 'Phone')
  for (const cookie of success.headers['set-cookie']) {
    assert.match(cookie, /; Secure/)
    assert.match(cookie, /; HttpOnly/)
    assert.match(cookie, /; SameSite=Strict/)
    assert.doesNotMatch(cookie, /Domain=/i)
  }
  assert.equal(success.headers['set-cookie'].length, 3)
  const snapshot = JSON.stringify(bridge.snapshot())
  for (const credential of [secret, LAUNCH, 'signed-internal-cookie', cookieHeader(success).split(`${GATE}=`)[1]]) {
    assert.equal(snapshot.includes(credential), false)
  }
  assert.deepEqual(Object.keys(bridge.snapshot().devices[0]).sort(), ['id', 'label', 'lastSeenAt', 'pairedAt'])
  assert.ok(changes.some(state => state.pairingExpiresAt === null && state.devices.length === 1))
  assert.equal((await redeem(bridge, pairing)).status, 401)
})

test('pairing page waits for explicit submission and validates names before redeeming', { timeout: 5000 }, async t => {
  const { bridge, state } = await fixture(t)
  const pairing = bridge.pairing()
  const preview = await request(bridge.origin, PAIR_PATH)
  const browser = pairingBrowser(preview.body, pairing)
  assert.equal(browser.automaticSubmissions, 0)
  assert.equal(browser.elements.label.value, '我的 iPhone')
  assert.equal(browser.elements.secret.value, secretOf(pairing))
  assert.equal(browser.elements.pair.disabled, false)
  assert.deepEqual(Array.from(browser.replacements[0]), [null, '', PAIR_PATH])
  assert.equal(state.exchanges, 0)
  for (const label of ['', '   ', 'a'.repeat(81), 'Phone\u0000', '\tPhone', 'Phone\u0085']) {
    browser.elements.label.value = label
    browser.elements.label.listeners.input()
    assert.equal(browser.clickPair(), false, JSON.stringify(label))
    assert.ok(browser.elements.label.validityMessage)
    assert.equal(bridge.snapshot().pairingExpiresAt, pairing.expiresAt)
    assert.equal(state.exchanges, 0)
  }
  for (const [ua, expected] of [['Android 16', '我的 Android 设备'], ['Windows NT 10.0', '我的 Windows 电脑'], ['iPad', '我的 iPad'], ['Macintosh', '我的 Mac'], ['', '我的设备']]) {
    const other = pairingBrowser(preview.body, pairing, ua)
    assert.equal(other.elements.label.value, expected)
    assert.equal(other.automaticSubmissions, 0)
  }
  const missing = pairingBrowser(preview.body, { url: `${PUBLIC}${PAIR_PATH}` })
  assert.equal(missing.elements.pair.disabled, true)
  assert.equal(missing.clickPair(), false)
  browser.elements.label.value = '  My work phone  '
  browser.elements.label.listeners.input()
  assert.equal(browser.clickPair(), true)
  assert.equal(browser.elements.label.value, 'My work phone')
  const response = await request(bridge.origin, PAIR_PATH, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: browser.elements.secret.value, label: browser.elements.label.value }).toString(),
  })
  assert.equal(response.status, 303)
  assert.equal(state.exchanges, 1)
  assert.equal(bridge.snapshot().devices[0].label, 'My work phone')
})

test('server rejects missing, blank, long or control-character names without consuming a pairing secret', { timeout: 5000 }, async t => {
  const { bridge, state } = await fixture(t)
  const pairing = bridge.pairing()
  for (const label of [undefined, null, 123, {}, '', ' \u2003 ', 'a'.repeat(81), 'Ph\u0000one', 'Phone\n', '\tPhone', 'Phone\u007f', 'Phone\u0085']) {
    const response = await request(bridge.origin, PAIR_PATH, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: secretOf(pairing), label }),
    })
    assert.equal(response.status, 400, JSON.stringify(label))
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(state.exchanges, 0)
    assert.equal(bridge.snapshot().pairingExpiresAt, pairing.expiresAt)
    assert.deepEqual(bridge.snapshot().devices, [])
  }
  const invalidForm = await request(bridge.origin, PAIR_PATH, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: secretOf(pairing), label: ' \t ' }).toString(),
  })
  assert.equal(invalidForm.status, 400)
  assert.equal(state.exchanges, 0)
  assert.equal(bridge.snapshot().pairingExpiresAt, pairing.expiresAt)
  const valid = await redeem(bridge, pairing, `  ${'a'.repeat(80)}  `)
  assert.equal(valid.status, 303)
  assert.equal(bridge.snapshot().devices[0].label, 'a'.repeat(80))
  assert.equal(state.exchanges, 1)
})

test('rotating and expiring pairing secrets invalidates them and clears expiry state', { timeout: 5000 }, async t => {
  const { bridge, state } = await fixture(t, { pairingTtlMs: 40 })
  const old = bridge.pairing()
  const fresh = bridge.pairing()
  assert.equal((await redeem(bridge, old)).status, 401)
  assert.equal(bridge.snapshot().pairingExpiresAt, fresh.expiresAt)
  await delay(70)
  assert.equal(bridge.snapshot().pairingExpiresAt, null)
  assert.equal((await redeem(bridge, fresh)).status, 401)
  assert.equal(state.exchanges, 0)
})

test('rejects wrong Host/Origin and absent, forged, duplicate or incomplete credentials', { timeout: 5000 }, async t => {
  const { bridge, state, seen } = await fixture(t)
  assert.equal((await request(bridge.origin)).status, 401)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: AUTH } })).status, 401)
  assert.equal((await request(bridge.origin, PAIR_PATH, { headers: { host: 'evil.example' } })).status, 403)
  assert.equal((await request(bridge.origin, PAIR_PATH, { headers: { origin: 'https://evil.example' } })).status, 403)
  const pairing = bridge.pairing()
  assert.equal((await redeem(bridge, pairing, 'x', { headers: { origin: undefined } })).status, 403)
  assert.equal(state.exchanges, 0)
  const cookie = await pair(bridge)
  for (const headers of [{ host: '127.0.0.1' }, { host: `${HOST}:443` }, { origin: 'null' }, { origin: `${PUBLIC}/` }]) {
    assert.equal((await request(bridge.origin, '/', { headers: { cookie, ...headers } })).status, 403)
  }
  assert.equal((await request(bridge.origin, '/echo', { method: 'POST', headers: { cookie, origin: undefined } })).status, 403)
  const gate = cookie.split('; ').find(value => value.startsWith(`${GATE}=`))
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: gate } })).status, 401)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: `${cookie}; ${gate}` } })).status, 401)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: `${AUTH}; ${GATE}=${'a'.repeat(43)}` } })).status, 401)
  assert.equal(seen.length, 0)
})

test('proxies authenticated HTTP bodies and rewrites authority, cookies and redirects', { timeout: 5000 }, async t => {
  let changes = 0
  const { bridge, target } = await fixture(t, { onChange: () => changes++ })
  const cookie = await pair(bridge)
  const before = changes
  const response = await request(bridge.origin, '/echo?x=1', {
    method: 'POST',
    headers: { cookie, referer: `${PUBLIC}/sessions/abc`, 'x-forwarded-host': 'evil.example', forwarded: 'host=evil.example', 'content-type': 'text/plain' },
    body: 'request-body',
  })
  assert.equal(response.status, 200)
  const echoed = JSON.parse(response.body)
  assert.equal(echoed.body, 'request-body')
  assert.equal(echoed.url, '/echo?x=1')
  assert.equal(echoed.headers.host, new URL(target).host)
  assert.equal(echoed.headers.origin, target)
  assert.equal(echoed.headers.referer, `${target}/sessions/abc`)
  assert.equal(echoed.headers.cookie, AUTH)
  assert.equal(echoed.headers.forwarded, undefined)
  assert.equal(echoed.headers['x-forwarded-host'], undefined)
  assert.equal(changes, before, 'ordinary requests update lastSeen without publishing structural changes')
  assert.ok(bridge.snapshot().devices[0].lastSeenAt >= bridge.snapshot().devices[0].pairedAt)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie, origin: undefined } })).status, 200)
  const redirect = await request(bridge.origin, '/redirect', { headers: { cookie } })
  assert.equal(redirect.headers.location, `${PUBLIC}/sessions/abc`)
  assert.match(redirect.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Strict/)
  assert.doesNotMatch(redirect.headers['set-cookie'][0], /Domain=/i)
})

test('blocks local management and connect paths including encoded, normalized and WS aliases', { timeout: 5000 }, async t => {
  const { bridge, seen } = await fixture(t)
  const cookie = await pair(bridge)
  const paths = [
    '/api/dsh-remote-control', '/api/dsh-remote-control/', '/api/dsh-remote-control/stop',
    '/api/%64sh-remote-control/status', '/api%2fdsh-remote-control%2fstop', '/%61pi/dsh-remote-control',
    '/api/%2564sh-remote-control', '/api//dsh-remote-control/stop', '/safe/../api/dsh-remote-control',
    '/safe/%2e%2e/api/dsh-remote-control', '/connect', '/connect/api', '/%63onnect', '/%2563onnect',
  ]
  for (const path of paths) {
    assert.equal((await request(bridge.origin, path, { headers: { cookie } })).status, 403, path)
    assert.equal((await upgraded(bridge.origin, { cookie, path })).status, 403, `WS ${path}`)
  }
  for (const path of ['/api%ZZ', '/api%5cdsh-remote-control', '//evil.example/', 'http://evil.example/']) {
    assert.equal((await request(bridge.origin, path, { headers: { cookie } })).status, 400, path)
  }
  assert.equal(seen.length, 0)
  assert.equal((await request(bridge.origin, '/api/dsh-remote-controller', { headers: { cookie } })).status, 200)
})

test('bridge rename publishes without rotating credentials, expiry, pairing or live connections', { timeout: 5000 }, async t => {
  const changes = []
  const { bridge, state } = await fixture(t, { onChange: value => changes.push(value) })
  const cookie = await pair(bridge)
  const device = { ...bridge.snapshot().devices[0] }
  const ownBefore = JSON.parse((await request(bridge.origin, '/__dsh_remote_device', { headers: { cookie } })).body)
  const pending = bridge.pairing()
  const ws = await upgraded(bridge.origin, { cookie })
  const active = await stream(bridge.origin, cookie)
  const before = changes.length
  for (const label of [undefined, '', '  ', 'a'.repeat(81), 'Phone\n', 'Phone\u0085']) {
    assert.throws(() => bridge.renameDevice(device.id, label), /Device name/)
  }
  assert.equal(changes.length, before)
  assert.equal(bridge.renameDevice('missing', 'Phone'), false)
  assert.equal(bridge.renameDevice(device.id, '  工作手机  '), true)
  assert.equal(changes.length, before + 1)
  assert.equal(changes.at(-1).devices[0].label, '工作手机')
  assert.equal(bridge.renameDevice(device.id, '工作手机'), true)
  assert.equal(changes.length, before + 1)
  const current = bridge.snapshot().devices[0]
  assert.equal(current.id, device.id)
  assert.equal(current.pairedAt, device.pairedAt)
  assert.equal(bridge.snapshot().pairingExpiresAt, pending.expiresAt)
  const ownAfter = await request(bridge.origin, '/__dsh_remote_device', { headers: { cookie } })
  assert.equal(ownAfter.status, 200)
  assert.equal(ownAfter.headers['set-cookie'], undefined)
  assert.equal(JSON.parse(ownAfter.body).expiresAt, ownBefore.expiresAt)
  assert.equal(state.exchanges, 1)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie } })).status, 200)
  assert.equal(active.res.destroyed, false)
  const echoed = once(ws.socket, 'data')
  ws.socket.write(maskedText('still-connected'))
  assert.equal((await echoed)[0].subarray(2).toString(), 'still-connected')
})

test('remote device endpoint is gated and can only read or rename its own device', { timeout: 5000 }, async t => {
  const changes = []
  const { bridge, seen } = await fixture(t, { onChange: value => changes.push(value) })
  const path = '/__dsh_remote_device'
  assert.equal((await request(bridge.origin, path)).status, 401)
  assert.equal((await request(bridge.origin, path, { headers: { cookie: AUTH } })).status, 401)
  const first = await pair(bridge)
  const second = cookieHeader(await redeem(bridge, bridge.pairing(), 'Other phone'))
  const [firstDevice, secondDevice] = bridge.snapshot().devices.map(device => ({ ...device }))
  const own = await request(bridge.origin, `${path}?deviceId=${secondDevice.id}`, { headers: { cookie: first, origin: undefined } })
  assert.equal(own.status, 200)
  assert.equal(own.headers['cache-control'], 'no-store')
  assert.equal(own.headers['set-cookie'], undefined)
  const current = JSON.parse(own.body)
  assert.deepEqual(Object.keys(current).sort(), ['expiresAt', 'id', 'label', 'pairedAt', 'refreshAfterMs', 'refreshExpiresAt', 'refreshRetryMs', 'serverTime'])
  assert.equal(current.id, firstDevice.id)
  assert.equal(current.label, 'My phone')
  assert.ok(current.expiresAt > current.pairedAt)
  assert.equal(own.body.includes(secondDevice.id), false)
  for (const input of [null, [], {}, { label: 'x', id: secondDevice.id }, { label: 'x', deviceId: secondDevice.id },
    { label: 'x', expiresAt: Date.now() + 99999999 }, { label: '' }, { label: '  ' }, { label: 'a'.repeat(81) }, { label: 'Phone\u0000' }]) {
    const response = await request(bridge.origin, path, {
      method: 'POST', headers: { cookie: first, 'content-type': 'application/json' }, body: JSON.stringify(input),
    })
    assert.equal(response.status, 400, JSON.stringify(input))
    assert.equal(response.headers['set-cookie'], undefined)
  }
  for (const headers of [{ origin: undefined }, { origin: 'null' }, { origin: 'https://evil.example' }, { host: 'evil.example' }]) {
    assert.equal((await request(bridge.origin, path, {
      method: 'POST', headers: { cookie: first, 'content-type': 'application/json', ...headers }, body: '{"label":"x"}',
    })).status, 403)
  }
  assert.equal((await request(bridge.origin, path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"label":"x"}',
  })).status, 401)
  assert.equal((await request(bridge.origin, path, { method: 'POST', headers: { cookie: first, 'content-type': 'text/plain' }, body: 'label=x' })).status, 415)
  assert.equal((await request(bridge.origin, path, { method: 'POST', headers: { cookie: first, 'content-type': 'application/json' }, body: '{' })).status, 400)
  const before = changes.length
  const renamed = await request(bridge.origin, `${path}?deviceId=${secondDevice.id}`, {
    method: 'POST', headers: { cookie: first, 'content-type': 'application/json; charset=utf-8' }, body: '{"label":"  Work iPhone  "}',
  })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.headers['set-cookie'], undefined)
  assert.equal(changes.length, before + 1)
  const renamedDevice = JSON.parse(renamed.body)
  assert.deepEqual({ ...renamedDevice, serverTime: current.serverTime, refreshAfterMs: current.refreshAfterMs }, { ...current, label: 'Work iPhone' })
  assert.equal(bridge.snapshot().devices[1].label, secondDevice.label)
  const other = await request(bridge.origin, path, { headers: { cookie: second } })
  assert.equal(JSON.parse(other.body).id, secondDevice.id)
  assert.equal(JSON.parse(other.body).label, 'Other phone')
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: first } })).status, 200)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: second } })).status, 200)
  assert.equal((await request(bridge.origin, path, { method: 'PUT', headers: { cookie: first } })).status, 405)
  assert.equal((await upgraded(bridge.origin, { cookie: first, path })).status, 403)
  assert.equal(seen.filter(request => request.url.startsWith(path)).length, 0)
  bridge.revokeDevice(firstDevice.id)
  assert.equal((await request(bridge.origin, path, { headers: { cookie: first } })).status, 401)
  assert.equal((await request(bridge.origin, path, { headers: { cookie: second } })).status, 200)
})

test('limits device count and revokes authentication without exposing credentials in snapshots', { timeout: 5000 }, async t => {
  const { bridge } = await fixture(t, { maxDevices: 1 })
  const first = await pair(bridge)
  const next = bridge.pairing()
  assert.equal((await redeem(bridge, next)).status, 409)
  const id = bridge.snapshot().devices[0].id
  assert.equal(bridge.revokeDevice(id), true)
  assert.equal(bridge.revokeDevice(id), false)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: first } })).status, 401)
  assert.equal((await redeem(bridge, next)).status, 303)
  assert.equal(bridge.snapshot().devices.length, 1)
})

test('WebSocket requires the device cookie and exact authority/origin and relays frames', { timeout: 5000 }, async t => {
  const { bridge, seen, target } = await fixture(t)
  assert.equal((await upgraded(bridge.origin)).status, 401)
  const cookie = await pair(bridge)
  for (const headers of [{ host: 'evil.example' }, { origin: 'https://evil.example' }, { origin: undefined }]) {
    assert.equal((await upgraded(bridge.origin, { cookie, headers })).status, 403)
  }
  const ws = await upgraded(bridge.origin, { cookie })
  assert.equal(ws.status, 101)
  const echoed = once(ws.socket, 'data')
  ws.socket.write(maskedText('hello'))
  assert.equal((await echoed)[0].subarray(2).toString(), 'hello')
  assert.equal(seen.at(-1).headers.host, new URL(target).host)
  assert.equal(seen.at(-1).headers.origin, target)
  assert.equal(seen.at(-1).headers.cookie, AUTH)
  const disconnected = once(ws.socket, 'close')
  bridge.revokeDevice(bridge.snapshot().devices[0].id)
  await disconnected
})

test('revocation closes existing HTTP/SSE and WS, while close destroys all remaining streams', { timeout: 5000 }, async t => {
  const { bridge, sse } = await fixture(t)
  const cookie = await pair(bridge)
  const ws = await upgraded(bridge.origin, { cookie })
  const active = await stream(bridge.origin, cookie)
  assert.equal(active.data, 'data: hello\n\n')
  const downstreamClosed = new Promise(resolve => active.res.once('close', resolve))
  const upstreamClosed = new Promise(resolve => sse[0].once('close', resolve))
  const wsClosed = once(ws.socket, 'close')
  assert.equal(bridge.revokeDevice(bridge.snapshot().devices[0].id), true)
  await Promise.all([downstreamClosed, upstreamClosed, wsClosed])
  const cookie2 = await pair(bridge)
  const ws2 = await upgraded(bridge.origin, { cookie: cookie2 })
  const active2 = await stream(bridge.origin, cookie2)
  const allClosed = [once(ws2.socket, 'close'), new Promise(resolve => active2.res.once('close', resolve)), new Promise(resolve => sse[1].once('close', resolve))]
  const closing = bridge.close()
  assert.equal(bridge.close(), closing)
  await Promise.all([closing, ...allClosed])
  assert.deepEqual(bridge.snapshot().devices, [])
  assert.equal(bridge.snapshot().externalOrigin, null)
  await assert.rejects(request(bridge.origin), /ECONNREFUSED|ECONNRESET/)
  assert.throws(() => bridge.pairing(), /active tunnel/)
})

test('access expiration tears down active streams while refresh retains the device', { timeout: 5000 }, async t => {
  const { bridge, state } = await fixture(t, { deviceTtlMs: 120 })
  const cookie = await pair(bridge)
  const ws = await upgraded(bridge.origin, { cookie })
  const active = await stream(bridge.origin, cookie)
  const closed = Promise.all([once(ws.socket, 'close'), new Promise(resolve => active.res.once('close', resolve))])
  await closed
  assert.equal(bridge.snapshot().devices.length, 1)
  assert.equal((await upgraded(bridge.origin, { cookie })).status, 401)
  const accessOnly = cookie.split('; ').filter(value => !value.startsWith('__Host-dsh-remote-refresh=')).join('; ')
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: accessOnly } })).status, 401)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie } })).status, 200)
  assert.equal(state.exchanges, 2)
})

test('tunnel changes invalidate existing devices and pairing links', { timeout: 5000 }, async t => {
  const { bridge } = await fixture(t)
  const cookie = await pair(bridge)
  const ws = await upgraded(bridge.origin, { cookie })
  const pending = bridge.pairing()
  const closed = once(ws.socket, 'close')
  const next = 'https://new-random-quick-tunnel.trycloudflare.com'
  bridge.setExternalOrigin(next)
  await closed
  assert.equal(bridge.snapshot().pairingExpiresAt, null)
  assert.equal(bridge.snapshot().devices.length, 0)
  assert.equal((await request(bridge.origin, '/', { headers: { host: new URL(next).host, origin: next, cookie } })).status, 401)
  assert.equal((await redeem(bridge, pending)).status, 403)
})

test('failed token exchange consumes the link and returns a fixed credential-free error', { timeout: 5000 }, async t => {
  const { bridge, state } = await fixture(t)
  state.exchangeStatus = 500
  const pairing = bridge.pairing()
  const failed = await redeem(bridge, pairing)
  assert.equal(failed.status, 502)
  assert.equal(failed.headers['set-cookie'], undefined)
  assert.equal(failed.body.includes(LAUNCH), false)
  assert.equal(failed.body.includes(secretOf(pairing)), false)
  assert.equal(bridge.snapshot().devices.length, 0)
  assert.equal(bridge.snapshot().pairingExpiresAt, null)
  assert.equal((await redeem(bridge, pairing)).status, 401)
})

test('closing cancels an in-flight internal token exchange and leaves no device', { timeout: 5000 }, async t => {
  const { bridge, state, events } = await fixture(t)
  state.hangExchange = true
  const exchangeStarted = once(events, 'exchange')
  const pairing = redeem(bridge, bridge.pairing()).catch(error => ({ error }))
  await exchangeStarted
  await bridge.close()
  const response = await pairing
  assert.ok(response.error || response.status === 502)
  assert.equal(bridge.snapshot().devices.length, 0)
})

test('isolates observer exceptions from carrier and authentication lifecycle', { timeout: 5000 }, async t => {
  let calls = 0
  const { bridge } = await fixture(t, { onChange: () => {
    if (++calls % 2) throw new Error('observer failed')
    return Promise.reject(new Error('async observer failed'))
  } })
  const cookie = await pair(bridge)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie } })).status, 200)
  bridge.revokeDevice(bridge.snapshot().devices[0].id)
  await bridge.close()
})

test('defaults to 8h access and 10d refresh and transparently re-signs a single business POST', { timeout: 5000 }, async t => {
  let time = Date.now()
  const { bridge, state, seen } = await fixture(t, { now: () => time })
  state.rotateAuth = true
  const initial = await pair(bridge)
  const metadata = JSON.parse((await request(bridge.origin, '/__dsh_remote_device', { headers: { cookie: initial } })).body)
  assert.equal(metadata.expiresAt, time + 8 * HOUR)
  assert.equal(metadata.refreshExpiresAt, time + 10 * DAY)
  assert.equal(metadata.serverTime, time)
  assert.equal(metadata.refreshAfterMs, 8 * HOUR - 300_000)
  assert.equal(metadata.refreshRetryMs, 30_000)
  time += 8 * HOUR + 1
  state.upstreamCookies = [`${GATE}=attacker; Path=/`, `${REFRESH_GATE}=attacker; Path=/`, 'theme=dark; Path=/', 'dsh-auth-test=stale; Path=/']
  const response = await request(bridge.origin, '/business', {
    method: 'POST', headers: { cookie: initial, 'content-type': 'text/plain' }, body: 'execute-once',
  })
  assert.equal(response.status, 200)
  assert.equal(state.exchanges, 2)
  assert.equal(seen.filter(value => value.url === '/business').length, 1)
  const echoed = JSON.parse(response.body)
  assert.equal(echoed.body, 'execute-once')
  assert.equal(echoed.headers.cookie, state.auth)
  assert.doesNotMatch(echoed.headers.cookie, /__Host-dsh-remote/)
  const next = cookieHeader(response)
  assert.notEqual(onlyCookie(next, GATE), onlyCookie(initial, GATE))
  assert.notEqual(onlyCookie(next, REFRESH_GATE), onlyCookie(initial, REFRESH_GATE))
  assert.ok(next.includes(state.auth))
  assert.ok(next.includes('theme=dark'))
  assert.equal(response.headers['set-cookie'].length, 4)
  assert.doesNotMatch(next, /attacker|stale/)
  for (const cookie of response.headers['set-cookie']) {
    assert.match(cookie, /Secure; HttpOnly; SameSite=Strict/)
    assert.doesNotMatch(cookie, /Domain=/i)
  }
  time += 8 * HOUR + 1
  const refreshOnly = onlyCookie(next, REFRESH_GATE)
  const coldStart = await request(bridge.origin, '/', { headers: { cookie: refreshOnly, origin: undefined } })
  assert.equal(coldStart.status, 200, 'HTML cold start only needs the surviving refresh cookie')
  assert.equal(state.exchanges, 3)
  assert.equal(JSON.parse(coldStart.body).headers.cookie, state.auth)
})

test('refresh requires exact authority/origin, JSON {} and the refresh cookie', { timeout: 5000 }, async t => {
  const { bridge, state } = await fixture(t)
  const cookie = await pair(bridge)
  for (const headers of [{ host: 'evil.example' }, { origin: undefined }, { origin: 'null' }, { origin: 'https://evil.example' }]) {
    assert.equal((await refresh(bridge, cookie, { headers })).status, 403)
  }
  for (const body of ['{', 'null', '[]', '{"label":"x"}', '{"token":"x"}']) {
    assert.equal((await refresh(bridge, cookie, { body })).status, 400)
  }
  assert.equal((await refresh(bridge, cookie, { headers: { 'content-type': 'text/plain' } })).status, 415)
  assert.equal((await refresh(bridge, cookie, { method: 'GET', body: '' })).status, 405)
  assert.equal((await upgraded(bridge.origin, { cookie, path: REFRESH_PATH })).status, 403)
  for (const credential of [undefined, AUTH, onlyCookie(cookie, GATE), `${AUTH}; ${onlyCookie(cookie, GATE)}`, `${REFRESH_GATE}=${'x'.repeat(43)}`]) {
    const rejected = await refresh(bridge, credential)
    assert.equal(rejected.status, 401)
    assert.equal(rejected.headers['set-cookie'], undefined)
  }
  assert.equal(state.exchanges, 1)
  const success = await refresh(bridge, onlyCookie(cookie, REFRESH_GATE))
  assert.equal(success.status, 200)
  assert.equal(state.exchanges, 2)
  assert.deepEqual(Object.keys(JSON.parse(success.body)).sort(), ['expiresAt', 'id', 'label', 'pairedAt', 'refreshAfterMs', 'refreshExpiresAt', 'refreshRetryMs', 'serverTime'])
  const forbidden = [LAUNCH, onlyCookie(cookie, GATE).split('=')[1], onlyCookie(cookie, REFRESH_GATE).split('=')[1],
    ...success.headers['set-cookie'].map(value => value.split(';')[0].split('=')[1])]
  for (const token of forbidden) {
    assert.equal(success.body.includes(token), false)
    assert.equal(JSON.stringify(bridge.snapshot()).includes(token), false)
  }
})

test('refresh success rolls ten days from success and expiration invalidates both credentials', { timeout: 5000 }, async t => {
  let time = Date.now()
  const { bridge, state } = await fixture(t, { now: () => time })
  const cookie = await pair(bridge)
  const pairedAt = time
  time += 9 * DAY
  const first = await refresh(bridge, cookie)
  assert.equal(first.status, 200)
  const firstMeta = JSON.parse(first.body)
  assert.equal(firstMeta.pairedAt, pairedAt)
  assert.equal(firstMeta.expiresAt, time + 8 * HOUR)
  assert.equal(firstMeta.refreshExpiresAt, time + 10 * DAY)
  time += 9 * DAY
  const second = await refresh(bridge, cookieHeader(first))
  assert.equal(second.status, 200)
  assert.equal(JSON.parse(second.body).refreshExpiresAt, time + 10 * DAY)
  assert.equal(state.exchanges, 3)
  time += 10 * DAY
  assert.equal((await refresh(bridge, cookieHeader(second))).status, 401)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: cookieHeader(second) } })).status, 401)
  assert.deepEqual(bridge.snapshot().devices, [])
})

test('same-device concurrent refreshes share one rotation and old refresh replay fails after grace', { timeout: 5000 }, async t => {
  let time = Date.now()
  const { bridge, state, events } = await fixture(t, { now: () => time })
  const cookie = await pair(bridge)
  state.hangExchange = true
  const started = once(events, 'exchange')
  const pending = [refresh(bridge, cookie), refresh(bridge, cookie), refresh(bridge, cookie)]
  await started
  state.hangExchange = false
  const exchange = state.pendingExchanges[0]
  exchange.writeHead(303, { location: '/', 'set-cookie': `${AUTH}; Path=/` })
  exchange.end()
  const responses = await Promise.all(pending)
  assert.deepEqual(responses.map(value => value.status), [200, 200, 200])
  assert.equal(state.exchanges, 2)
  for (const response of responses) assert.deepEqual(response.headers['set-cookie'], responses[0].headers['set-cookie'])
  const fresh = cookieHeader(responses[0])
  time += 1000
  const currentDuringGrace = await refresh(bridge, fresh)
  assert.equal(currentDuringGrace.status, 200)
  assert.deepEqual(currentDuringGrace.headers['set-cookie'], responses[0].headers['set-cookie'])
  const oldDuringGrace = await refresh(bridge, cookie)
  assert.equal(oldDuringGrace.status, 200)
  assert.deepEqual(oldDuringGrace.headers['set-cookie'], responses[0].headers['set-cookie'])
  assert.equal(state.exchanges, 2)
  time += 120_001
  const replay = await refresh(bridge, cookie)
  assert.equal(replay.status, 401)
  assert.equal(replay.headers['set-cookie'], undefined)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: fresh } })).status, 200)
  assert.equal((await refresh(bridge, fresh)).status, 200)
  assert.equal(state.exchanges, 3)
})

test('a lost rotation response recovers with the old refresh after 60s but not after 120s', { timeout: 5000 }, async t => {
  let time = Date.now()
  const { bridge, state } = await fixture(t, { now: () => time })
  const original = await pair(bridge)
  const lost = await refresh(bridge, original)
  assert.equal(lost.status, 200)
  // The browser retains its original cookies: neither Set-Cookie from the lost
  // response nor its metadata is applied before timeout + retry has elapsed.
  time += 60_000
  const recovered = await refresh(bridge, original)
  assert.equal(recovered.status, 200)
  assert.deepEqual(recovered.headers['set-cookie'], lost.headers['set-cookie'])
  assert.equal(state.exchanges, 2, 'recovery reuses the completed rotation')
  time += 61_000
  const replay = await refresh(bridge, original)
  assert.equal(replay.status, 401)
  assert.equal(replay.headers['set-cookie'], undefined)
  const current = cookieHeader(recovered)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: current } })).status, 200)
  assert.equal((await refresh(bridge, current)).status, 200)
  assert.equal(state.exchanges, 3)
})

test('refresh is isolated by device and unknown tokens cannot revoke another pairing', { timeout: 5000 }, async t => {
  const { bridge } = await fixture(t)
  const first = await pair(bridge)
  const second = cookieHeader(await redeem(bridge, bridge.pairing(), 'Other device'))
  const [one, two] = bridge.snapshot().devices
  const renewed = await refresh(bridge, second)
  assert.equal(JSON.parse(renewed.body).id, two.id)
  assert.equal((await refresh(bridge, `${REFRESH_GATE}=${'z'.repeat(43)}`)).status, 401)
  bridge.revokeDevice(one.id)
  assert.equal((await refresh(bridge, first)).status, 401)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: first } })).status, 401)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: cookieHeader(renewed) } })).status, 200)
})

test('access expiration closes HTTP and WS; refreshed access reconnects without interrupting live streams', { timeout: 5000 }, async t => {
  let time = Date.now()
  const { bridge } = await fixture(t, { now: () => time })
  const cookie = await pair(bridge)
  const ws = await upgraded(bridge.origin, { cookie })
  const active = await stream(bridge.origin, cookie)
  const stopped = Promise.all([once(ws.socket, 'close'), new Promise(resolve => active.res.once('close', resolve))])
  time += 8 * HOUR + 1
  assert.equal(bridge.snapshot().devices.length, 1)
  await stopped
  assert.equal((await upgraded(bridge.origin, { cookie })).status, 401)
  const renewed = await refresh(bridge, cookie)
  assert.equal(renewed.status, 200)
  const next = cookieHeader(renewed)
  const reconnected = await upgraded(bridge.origin, { cookie: next })
  assert.equal(reconnected.status, 101)
  const events = await stream(bridge.origin, next)
  time += 121_000
  const again = await refresh(bridge, next)
  assert.equal(again.status, 200)
  assert.equal(events.res.destroyed, false)
  const echoed = once(reconnected.socket, 'data')
  reconnected.socket.write(maskedText('still-live-after-refresh'))
  assert.equal((await echoed)[0].subarray(2).toString(), 'still-live-after-refresh')
  const stoppedAgain = Promise.all([once(reconnected.socket, 'close'), new Promise(resolve => events.res.once('close', resolve))])
  bridge.revokeDevice(bridge.snapshot().devices[0].id)
  await stoppedAgain
})

test('a delayed proxy response cannot overwrite cookies from a newer refresh generation', { timeout: 5000 }, async t => {
  let time = Date.now()
  const { bridge, state, events } = await fixture(t, { now: () => time })
  const cookie = await pair(bridge)
  time += 8 * HOUR + 1
  state.holdResponses = true
  state.upstreamCookies = [`${AUTH}; Path=/`, `${GATE}=attacker; Path=/`, `${REFRESH_GATE}=attacker; Path=/`]
  const started = once(events, 'business')
  const slow = request(bridge.origin, '/slow', { headers: { cookie } })
  await started
  const first = await refresh(bridge, cookie)
  assert.equal(first.status, 200)
  time += 121_000
  const newer = await refresh(bridge, cookieHeader(first))
  assert.equal(newer.status, 200)
  state.holdResponses = false
  state.pendingResponses[0]()
  const response = await slow
  assert.equal(response.status, 200)
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal((await request(bridge.origin, '/', { headers: { cookie: cookieHeader(newer) } })).status, 200)
})

test('revoke, domain changes and close cancel pending refresh without issuing late cookies', { timeout: 5000 }, async t => {
  for (const operation of ['revoke', 'domain', 'close']) {
    await t.test(operation, async t => {
      const { bridge, state, events } = await fixture(t)
      const cookie = await pair(bridge)
      const id = bridge.snapshot().devices[0].id
      state.hangExchange = true
      const started = once(events, 'exchange')
      const pending = refresh(bridge, cookie).catch(error => ({ error }))
      await started
      if (operation === 'revoke') bridge.revokeDevice(id)
      if (operation === 'domain') bridge.setExternalOrigin('https://new-random-quick-tunnel.trycloudflare.com')
      if (operation === 'close') await bridge.close()
      const result = await pending
      assert.ok(result.error || [401, 502].includes(result.status))
      assert.equal(result.headers?.['set-cookie'], undefined)
      assert.deepEqual(bridge.snapshot().devices, [])
    })
  }
})
