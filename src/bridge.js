import http from 'node:http'
import https from 'node:https'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import httpProxy from 'http-proxy'

const PAIR_PATH = '/__dsh_remote_pair'
const DEVICE_PATH = '/__dsh_remote_device'
const REFRESH_PATH = '/__dsh_remote_refresh'
const DEVICE_COOKIE = '__Host-dsh-remote-device'
const REFRESH_COOKIE = '__Host-dsh-remote-refresh'
const DEVICE = Symbol('remote-device')
const RENEWAL = Symbol('remote-renewal')
const ACCESS_HASH = Symbol('remote-access-hash')
const REFRESH_GRACE_MS = 120_000
const MAX_TIMER = 2 ** 31 - 1
const NO_STORE = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Device names are required, trimmed, and never silently repaired or truncated. */
export function normalizeDeviceLabel(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new TypeError('Device name must contain 1–80 characters and no control characters.')
  }
  const label = value.trim()
  if (!label || label.length > 80) {
    throw new TypeError('Device name must contain 1–80 characters and no control characters.')
  }
  return label
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER - Date.now()) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer within its supported range`)
  }
  return value
}

function targetUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new TypeError('target must be a loopback HTTP or HTTPS origin')
  }
  return url
}

function externalUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.port || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(url.hostname)) {
    throw new TypeError('external origin must be an HTTPS Quick Tunnel origin')
  }
  return url
}

// Decode before normalizing dots/slashes so encoded and double-encoded aliases
// cannot reach management routes through a different upstream URL parser.
function canonicalPath(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
    throw new RequestError(400, 'Invalid request path')
  }
  let path = rawUrl.split('?')[0]
  for (let attempt = 0; attempt < 8; attempt++) {
    let decoded
    try { decoded = decodeURIComponent(path) } catch { throw new RequestError(400, 'Invalid request path') }
    if (decoded === path) break
    path = decoded
    if (attempt === 7 && path.includes('%')) throw new RequestError(400, 'Invalid request path')
  }
  if (/[\\?#\u0000-\u001f\u007f]/.test(path)) throw new RequestError(400, 'Invalid request path')
  return new URL(path.replace(/\/{2,}/g, '/'), 'http://bridge.invalid').pathname
}

function blockedPath(path) {
  const lower = path.toLowerCase()
  return lower === '/api/dsh-remote-control' || lower.startsWith('/api/dsh-remote-control/')
    || lower === '/connect' || lower.startsWith('/connect/')
}

function sessionLocation(value = '/') {
  const path = canonicalPath(value)
  if (blockedPath(path) || path === PAIR_PATH || path === DEVICE_PATH || path === REFRESH_PATH || /[\r\n#]/.test(value)) {
    throw new TypeError('sessionPath must be an ordinary local DSH path')
  }
  const url = new URL(value, 'https://bridge.invalid')
  if (url.origin !== 'https://bridge.invalid' || url.searchParams.has('token')) {
    throw new TypeError('sessionPath must be an ordinary local DSH path')
  }
  return `${url.pathname}${url.search}`
}

function cookieToken(raw, name = DEVICE_COOKIE) {
  if (typeof raw !== 'string') return undefined
  const matches = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
  if (!matches.length) return undefined
  if (matches.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(matches[0].slice(name.length + 1))) {
    throw new RequestError(401, 'Invalid device credential')
  }
  return matches[0].slice(name.length + 1)
}

function externalCookie(raw, expiresAt, time) {
  const [pair, ...attributes] = raw.split(';').map(part => part.trim())
  if (!/^[!#$%&'*+.^_`|~\w-]+=[\x21-\x3a\x3c-\x7e]*$/.test(pair)
    || [DEVICE_COOKIE, REFRESH_COOKIE].some(name => pair.startsWith(`${name}=`))) return undefined
  const retained = attributes.filter(attribute => !/^(domain|path|secure|httponly|samesite|expires|max-age)(?:=|$)/i.test(attribute))
  let expiry = expiresAt
  let deleted = false
  for (const attribute of attributes) {
    if (/^expires=/i.test(attribute)) {
      const parsed = Date.parse(attribute.slice(8))
      if (Number.isFinite(parsed)) expiry = Math.min(expiry, parsed)
    }
    if (/^max-age=/i.test(attribute)) {
      const seconds = Number(attribute.slice(8))
      if (Number.isFinite(seconds)) {
        deleted ||= seconds <= 0
        expiry = Math.min(expiry, time + Math.max(0, seconds) * 1000)
      }
    }
  }
  const age = deleted ? 0 : Math.max(0, Math.ceil((expiry - time) / 1000))
  return [pair, ...retained, 'Path=/', `Max-Age=${age}`, `Expires=${new Date(expiry).toUTCString()}`,
    'Secure', 'HttpOnly', 'SameSite=Strict'].join('; ')
}

function deviceCookie(name, token, expiresAt, time) {
  return `${name}=${token}; Path=/; Max-Age=${Math.max(0, Math.ceil((expiresAt - time) / 1000))}; Expires=${new Date(expiresAt).toUTCString()}; Secure; HttpOnly; SameSite=Strict`
}

function mergeCookies(...groups) {
  const cookies = new Map()
  for (const cookie of groups.flat()) cookies.set(cookie.split('=')[0], cookie)
  return [...cookies.values()]
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    let failed = false
    req.on('data', chunk => {
      length += chunk.length
      if (length > 8192) {
        if (!failed) reject(new RequestError(413, 'Pairing request too large'))
        failed = true
        chunks.length = 0
      } else if (!failed) chunks.push(chunk)
    })
    req.once('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.once('error', () => reject(new RequestError(400, 'Invalid pairing request')))
    req.once('aborted', () => reject(new RequestError(400, 'Invalid pairing request')))
  })
}

function pairingPage() {
  const nonce = randomBytes(18).toString('base64')
  return {
    csp: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>配对 DeepSeek Harness</title><style nonce="${nonce}">body{font:16px system-ui;max-width:28rem;margin:12vh auto;padding:1.5rem;line-height:1.6}input,button{box-sizing:border-box;width:100%;font:inherit;padding:.75rem;margin-top:.75rem}button{cursor:pointer}p{color:#555}</style><h1>配对此设备</h1><p>确认设备名称后，此设备可以访问你的 DeepSeek Harness。</p><form method="post" action="${PAIR_PATH}"><input type="hidden" name="secret" id="secret"><label>设备名称<input id="label" name="label" required minlength="1" maxlength="80" placeholder="例如：我的手机" autocomplete="off"></label><button id="pair" type="submit" disabled>配对并进入</button></form><p id="status" role="status">请使用电脑上生成的配对二维码打开此页面。</p><script nonce="${nonce}">
const secret = new URLSearchParams(location.hash.slice(1)).get('secret');
history.replaceState(null, '', location.pathname);
const form = document.querySelector('form');
const label = document.getElementById('label');
const status = document.getElementById('status');
const normalizeLabel = ${normalizeDeviceLabel.toString()};
const ua = navigator.userAgent || '';
label.value = /iPad/i.test(ua) ? '我的 iPad' : /iPhone/i.test(ua) ? '我的 iPhone' : /Android/i.test(ua) ? '我的 Android 设备' : /Windows/i.test(ua) ? '我的 Windows 电脑' : /Macintosh|Mac OS X/i.test(ua) ? '我的 Mac' : /Linux/i.test(ua) ? '我的 Linux 设备' : '我的设备';
function validateLabel() {
  try { normalizeLabel(label.value); label.setCustomValidity(''); return true; }
  catch { label.setCustomValidity('请输入 1–80 个字符的设备名称，不能包含控制字符或全为空白。'); return false; }
}
label.addEventListener('input', validateLabel);
form.addEventListener('submit', event => {
  if (!secret || !validateLabel()) { event.preventDefault(); label.reportValidity(); return; }
  label.value = normalizeLabel(label.value);
  status.textContent = '正在配对并进入 DeepSeek Harness…';
});
if (secret) {
  document.getElementById('secret').value = secret;
  document.getElementById('pair').disabled = false;
  status.textContent = '确认设备名称后，点击“配对并进入”。';
}
</script></html>`,
  }
}

function respond(res, status, message, headers = {}) {
  if (res.destroyed) return
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(message)
}

function rejectUpgrade(socket, status) {
  if (socket.destroyed) return
  const message = http.STATUS_CODES[status] || 'Rejected'
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`)
}

function track(set, stream) {
  set.add(stream)
  stream.once('close', () => set.delete(stream))
}

/**
 * Loopback-only carrier for a Cloudflare Quick Tunnel. The tunnel terminates TLS;
 * every public request is checked against its exact external authority first.
 * Pairing secrets and browser credentials are deliberately absent from snapshots.
 */
export async function createRemoteBridge({
  target,
  authenticatedUrl,
  pairingTtlMs = 120_000,
  deviceTtlMs = 8 * 60 * 60 * 1000,
  refreshTtlMs = 10 * 24 * 60 * 60 * 1000,
  refreshAheadMs = 300_000,
  refreshRetryMs = 30_000,
  now = Date.now,
  maxDevices = 8,
  onChange,
} = {}) {
  const upstream = targetUrl(target)
  if (typeof authenticatedUrl !== 'function') throw new TypeError('authenticatedUrl must be a function')
  positiveInteger(pairingTtlMs, 'pairingTtlMs', 10 * 60 * 1000)
  positiveInteger(deviceTtlMs, 'deviceTtlMs')
  positiveInteger(refreshTtlMs, 'refreshTtlMs')
  positiveInteger(refreshAheadMs, 'refreshAheadMs')
  positiveInteger(refreshRetryMs, 'refreshRetryMs')
  if (typeof now !== 'function' || !Number.isSafeInteger(now()) || now() < 0) throw new TypeError('now must return an epoch millisecond integer')
  positiveInteger(maxDevices, 'maxDevices', 256)
  let external
  let origin
  let closed = false
  let closing
  let pairingState
  let pairingTimer
  let pendingPairings = 0
  const devices = new Map()
  const deviceTokens = new Map()
  const refreshTokens = new Map()
  const sockets = new Set()
  const exchanges = new Set()
  const agent = upstream.protocol === 'https:' ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false })
  const proxy = httpProxy.createProxyServer({ target: upstream.origin, changeOrigin: true, xfwd: false, agent })

  function snapshot() {
    for (const device of devices.values()) {
      if (device.refreshExpiresAt <= now()) destroyDevice(device)
      else if (device.expiresAt <= now()) destroyStreams(device)
    }
    return {
      origin,
      externalOrigin: external?.origin ?? null,
      pairingExpiresAt: pairingState?.expiresAt ?? null,
      devices: [...devices.values()].map(({ id, label, pairedAt, lastSeenAt }) => ({ id, label, pairedAt, lastSeenAt })),
    }
  }

  function changed() {
    if (typeof onChange !== 'function') return
    try {
      Promise.resolve(onChange(snapshot())).catch(error => {
        // A rejected observer must not interrupt authentication or a socket teardown.
        void error
      })
    } catch (error) {
      // A synchronous observer has the same isolation boundary; never log credentials.
      void error
    }
  }

  function clearPairing() {
    clearTimeout(pairingTimer)
    pairingTimer = undefined
    pairingState = undefined
  }

  function clearGrace(device) {
    const grace = device.grace
    if (!grace) return
    clearTimeout(grace.timer)
    if (grace.sourceHash !== device.refreshHash) refreshTokens.delete(grace.sourceHash)
    device.grace = undefined
  }

  function destroyStreams(device) {
    for (const stream of device.streams) stream.destroy()
    device.streams.clear()
  }

  function destroyDevice(device) {
    device.revoked = true
    device.refreshController?.abort()
    clearTimeout(device.timer)
    clearGrace(device)
    devices.delete(device.id)
    deviceTokens.delete(device.hash)
    refreshTokens.delete(device.refreshHash)
    destroyStreams(device)
  }

  function trackDevice(device, stream) {
    if (closed || device.revoked || device.expiresAt <= now()) stream.destroy()
    else track(device.streams, stream)
  }

  function expireDevice(device) {
    clearTimeout(device.timer)
    if (device.revoked) return
    const time = now()
    if (device.refreshExpiresAt <= time) { destroyDevice(device); changed(); return }
    if (device.expiresAt <= time) destroyStreams(device)
    const deadline = device.expiresAt > time ? Math.min(device.expiresAt, device.refreshExpiresAt) : device.refreshExpiresAt
    device.timer = setTimeout(() => expireDevice(device), Math.min(deadline - time, MAX_TIMER))
    device.timer.unref()
  }

  function checkRequest(req, websocket = false) {
    if (closed || !external) throw new RequestError(503, 'Remote access is unavailable')
    if (req.headers.host !== external.host) throw new RequestError(403, 'Invalid request authority')
    // Missing Origin is normal for navigations/assets. Mutations and WebSocket
    // handshakes must positively identify the same HTTPS origin.
    const requiresOrigin = websocket || !['GET', 'HEAD'].includes(req.method)
    if ((req.headers.origin !== undefined && req.headers.origin !== external.origin)
      || (requiresOrigin && req.headers.origin !== external.origin)) {
      throw new RequestError(403, 'Invalid request origin')
    }
    const path = canonicalPath(req.url)
    if (blockedPath(path)) throw new RequestError(403, 'Remote management is unavailable')
    return path
  }

  function authorize(req, allowExpired = false) {
    const token = cookieToken(req.headers.cookie)
    const device = token && deviceTokens.get(digest(token))
    if (!device) {
      if (allowExpired) return undefined
      throw new RequestError(401, 'Pair this device before connecting')
    }
    if (device.refreshExpiresAt <= now()) {
      destroyDevice(device)
      changed()
      throw new RequestError(401, 'Device pairing has expired')
    }
    if (device.expiresAt <= now()) {
      expireDevice(device)
      if (allowExpired) return undefined
      throw new RequestError(401, 'Device access has expired')
    }
    device.lastSeenAt = now()
    req[DEVICE] = device
    return device
  }

  function renameDevice(id, value) {
    const label = normalizeDeviceLabel(value)
    const device = devices.get(id)
    if (!device) return false
    if (device.refreshExpiresAt <= now()) {
      destroyDevice(device)
      changed()
      return false
    }
    if (device.label !== label) {
      device.label = label
      changed()
    }
    return true
  }

  function ownDevice(device) {
    const { id, label, pairedAt, expiresAt, refreshExpiresAt } = device
    const serverTime = now()
    return { id, label, pairedAt, expiresAt, refreshExpiresAt, serverTime,
      refreshAfterMs: Math.max(0, expiresAt - serverTime - refreshAheadMs), refreshRetryMs }
  }

  async function manageDevice(req, res, device) {
    if (req.method === 'POST') {
      if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new RequestError(415, 'Use a JSON device name')
      }
      let input
      try { input = JSON.parse(await readBody(req)) } catch (error) {
        if (error instanceof RequestError) throw error
        throw new RequestError(400, 'Invalid device request')
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'label')) {
        throw new RequestError(400, 'Provide only this device’s name')
      }
      let label
      try { label = normalizeDeviceLabel(input.label) } catch (error) { throw new RequestError(400, error.message) }
      // The device can expire or be revoked while its request body arrives.
      if (!renameDevice(device.id, label)) throw new RequestError(401, 'Device pairing has expired')
    } else if (req.method !== 'GET') {
      respond(res, 405, 'Method not allowed', { allow: 'GET, POST' })
      return
    }
    const renewal = req[RENEWAL]
    requireLive(device)
    if (device.expiresAt <= now()) { expireDevice(device); throw new RequestError(401, 'Device access has expired') }
    respond(res, 200, JSON.stringify(ownDevice(device)), { 'content-type': 'application/json; charset=utf-8',
      ...(renewal?.hash === device.hash ? { 'set-cookie': renewal.cookies } : {}) })
    delete req[RENEWAL]
  }

  function rewriteRequest(req) {
    req.headers.host = upstream.host
    if (req.headers.origin !== undefined) req.headers.origin = upstream.origin
    if (req.headers.referer) {
      try {
        const referrer = new URL(req.headers.referer)
        req.headers.referer = referrer.origin === external.origin ? new URL(`${referrer.pathname}${referrer.search}`, upstream).href : undefined
      } catch { delete req.headers.referer }
      if (!req.headers.referer) delete req.headers.referer
    }
    for (const name of Object.keys(req.headers)) {
      if (name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip') delete req.headers[name]
    }
    const cookies = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(Boolean)
      .filter(part => ![DEVICE_COOKIE, REFRESH_COOKIE].includes(part.split('=')[0]))
    req.headers.cookie = mergeCookies(cookies, (req[RENEWAL]?.authCookies ?? []).map(cookie => cookie.split(';')[0])).join('; ')
    if (!req.headers.cookie) delete req.headers.cookie
  }

  async function exchangeCookies(signal) {
    // The injected callback is trusted code, but its result is confined to the
    // local root so a configuration mistake cannot send a launch token away.
    const value = await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('Exchange cancelled'))
      const aborted = () => reject(new Error('Exchange cancelled'))
      signal.addEventListener('abort', aborted, { once: true })
      Promise.resolve().then(() => authenticatedUrl(new URL('/', upstream).href)).then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', aborted))
    })
    const url = new URL(value)
    if (url.origin !== upstream.origin || url.pathname !== '/' || url.username || url.password || url.hash) {
      throw new Error('Invalid authentication URL')
    }
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http
      const request = transport.get(url, { agent, signal, headers: { host: upstream.host, origin: upstream.origin } }, response => {
        const cookies = response.headers['set-cookie'] ?? []
        // Never follow the token exchange's redirect or return its URL/error.
        response.destroy()
        if (![302, 303].includes(response.statusCode) || !cookies.some(cookie => /^dsh-auth-[^=]+=/.test(cookie))) {
          reject(new Error('Authentication cookie exchange failed'))
        } else resolve(cookies)
      })
      request.once('error', reject)
    })
  }

  function credentials(cookies, time) {
    const expiresAt = time + deviceTtlMs
    const refreshExpiresAt = time + refreshTtlMs
    const access = randomBytes(32).toString('base64url')
    const refresh = randomBytes(32).toString('base64url')
    const authCookies = cookies.map(cookie => externalCookie(cookie, expiresAt, time)).filter(Boolean)
    if (!authCookies.some(cookie => /^dsh-auth-[^=]+=/.test(cookie))) throw new Error('Invalid authentication cookie')
    return { hash: digest(access), refreshHash: digest(refresh), expiresAt, refreshExpiresAt, authCookies,
      cookies: [...authCookies, deviceCookie(DEVICE_COOKIE, access, expiresAt, time),
        deviceCookie(REFRESH_COOKIE, refresh, refreshExpiresAt, time)] }
  }

  function requireLive(device) {
    if (closed || device.revoked || !external || device.origin !== external.origin
      || device.refreshExpiresAt <= now()) throw new RequestError(401, 'Device pairing has expired')
  }

  async function refreshDevice(req) {
    const token = cookieToken(req.headers.cookie, REFRESH_COOKIE)
    const hash = token && digest(token)
    const device = hash && refreshTokens.get(hash)
    if (!device) throw new RequestError(401, 'Refresh credential is required')
    if (device.refreshExpiresAt <= now()) { destroyDevice(device); changed() }
    requireLive(device)
    if (device.grace && device.grace.until <= now()) clearGrace(device)
    if (hash !== device.refreshHash && hash !== device.grace?.sourceHash) {
      throw new RequestError(401, 'Refresh credential has expired')
    }
    // Every request in this rotation, including requests already using the new
    // cookie, receives the same result. No competing rotation can race it.
    if (device.grace && device.expiresAt > now()) return { device, result: device.grace.result }
    if (hash !== device.refreshHash) throw new RequestError(401, 'Refresh credential has expired')
    if (!device.refreshing) {
      const controller = new AbortController()
      const expectedOrigin = external.origin
      device.refreshController = controller
      exchanges.add(controller)
      const timeout = setTimeout(() => controller.abort(), 5000)
      timeout.unref()
      device.refreshing = (async () => {
        try {
          const cookies = await exchangeCookies(controller.signal)
          requireLive(device)
          if (controller.signal.aborted || external.origin !== expectedOrigin) throw new Error('Exchange cancelled')
          const result = credentials(cookies, now())
          // Expired streams must close even if the timer has not run yet.
          if (device.expiresAt <= now()) destroyStreams(device)
          clearGrace(device)
          const sourceHash = device.refreshHash
          deviceTokens.delete(device.hash)
          Object.assign(device, { hash: result.hash, refreshHash: result.refreshHash,
            expiresAt: result.expiresAt, refreshExpiresAt: result.refreshExpiresAt, lastSeenAt: now() })
          deviceTokens.set(device.hash, device)
          refreshTokens.set(device.refreshHash, device)
          const grace = { sourceHash, result, until: now() + REFRESH_GRACE_MS }
          device.grace = grace
          grace.timer = setTimeout(() => { if (device.grace === grace) clearGrace(device) }, REFRESH_GRACE_MS)
          grace.timer.unref()
          expireDevice(device)
          changed()
          return result
        } catch (error) {
          if (error instanceof RequestError) throw error
          throw new RequestError(502, 'Device refresh could not be completed. Try again.')
        } finally {
          clearTimeout(timeout)
          exchanges.delete(controller)
          device.refreshController = undefined
          device.refreshing = undefined
        }
      })()
    }
    const result = await device.refreshing
    requireLive(device)
    return { device, result }
  }

  async function refresh(req, res) {
    if (req.method !== 'POST') { respond(res, 405, 'Method not allowed', { allow: 'POST' }); return }
    if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new RequestError(415, 'Use an empty JSON refresh request')
    }
    let input
    try { input = JSON.parse(await readBody(req)) } catch (error) {
      if (error instanceof RequestError) throw error
      throw new RequestError(400, 'Invalid refresh request')
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
      throw new RequestError(400, 'Provide only an empty JSON object')
    }
    const { device, result } = await refreshDevice(req)
    requireLive(device)
    respond(res, 200, JSON.stringify(ownDevice(device)), {
      'content-type': 'application/json; charset=utf-8', 'set-cookie': result.cookies,
    })
  }

  async function redeem(req, res) {
    const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (!['application/json', 'application/x-www-form-urlencoded'].includes(contentType)) {
      throw new RequestError(415, 'Unsupported pairing request')
    }
    const body = await readBody(req)
    let input
    try { input = contentType === 'application/json' ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)) } catch {
      throw new RequestError(400, 'Invalid pairing request')
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['secret', 'label'].includes(key))) {
      throw new RequestError(400, 'Provide only a pairing secret and device name')
    }
    let label
    try { label = normalizeDeviceLabel(input.label) } catch (error) { throw new RequestError(400, error.message) }
    const secret = input.secret
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)
      || !pairingState || pairingState.expiresAt <= now() || digest(secret) !== pairingState.hash) {
      throw new RequestError(401, 'Pairing link is invalid or expired')
    }
    if (devices.size + pendingPairings >= maxDevices) throw new RequestError(409, 'Device limit reached')
    const claim = pairingState
    clearPairing()
    pendingPairings++
    changed()
    const controller = new AbortController()
    exchanges.add(controller)
    const timeout = setTimeout(() => controller.abort(), 5000)
    timeout.unref()
    const disconnected = () => { if (!res.writableFinished) controller.abort() }
    res.once('close', disconnected)
    try {
      const cookies = await exchangeCookies(controller.signal)
      if (closed || controller.signal.aborted || external?.origin !== claim.origin || res.destroyed) throw new Error('Exchange cancelled')
      const pairedAt = now()
      const result = credentials(cookies, pairedAt)
      const device = { id: randomUUID(), hash: result.hash, refreshHash: result.refreshHash, label,
        origin: external.origin, pairedAt, lastSeenAt: pairedAt, expiresAt: result.expiresAt,
        refreshExpiresAt: result.refreshExpiresAt, streams: new Set() }
      devices.set(device.id, device)
      deviceTokens.set(device.hash, device)
      refreshTokens.set(device.refreshHash, device)
      expireDevice(device)
      res.writeHead(303, { ...NO_STORE, location: claim.sessionPath, 'set-cookie': result.cookies })
      res.end()
      changed()
    } catch {
      // Node transport errors can embed the request URL, so only this fixed
      // message crosses the public boundary. No credential is logged.
      respond(res, 502, 'Pairing could not be completed. Generate a new pairing link.')
    } finally {
      clearTimeout(timeout)
      exchanges.delete(controller)
      pendingPairings--
      res.off('close', disconnected)
    }
  }

  proxy.on('proxyReq', (request, req) => trackDevice(req[DEVICE], request))
  proxy.on('proxyRes', (response, req) => {
    const device = req[DEVICE]
    trackDevice(device, response)
    if (closed || device.revoked || device.expiresAt <= now()) return response.destroy()
    const current = req[ACCESS_HASH] === device.hash
    const cookies = (response.headers['set-cookie'] ?? [])
      .filter(cookie => current || !/^dsh-auth-[^=]+=/.test(cookie))
      .map(cookie => externalCookie(cookie, device.expiresAt, now())).filter(Boolean)
    const merged = mergeCookies(cookies, current ? req[RENEWAL]?.cookies ?? [] : [])
    delete req[RENEWAL]
    if (merged.length) response.headers['set-cookie'] = merged
    else delete response.headers['set-cookie']
    const location = response.headers.location
    if (location) {
      try {
        const destination = new URL(location, upstream)
        if (destination.origin === upstream.origin) response.headers.location = `${external.origin}${destination.pathname}${destination.search}${destination.hash}`
      } catch { delete response.headers.location }
    }
  })
  proxy.on('proxyReqWs', (request, req) => {
    trackDevice(req[DEVICE], request)
    request.once('upgrade', (_response, socket) => trackDevice(req[DEVICE], socket))
  })
  proxy.on('error', (_error, _req, response) => {
    if (typeof response?.writeHead === 'function') respond(response, 502, 'Remote upstream is unavailable')
    else response?.destroy()
  })

  const server = http.createServer((req, res) => {
    Promise.resolve().then(async () => {
      const path = checkRequest(req)
      if (path === PAIR_PATH) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const page = pairingPage()
          // no-referrer makes Chromium navigation POSTs send Origin: null.
          // The secret is a fragment, removed before submission; same-origin keeps it private.
          res.writeHead(200, { ...NO_STORE, 'referrer-policy': 'same-origin', 'content-type': 'text/html; charset=utf-8', 'content-security-policy': page.csp })
          res.end(req.method === 'HEAD' ? undefined : page.html)
        } else if (req.method === 'POST') await redeem(req, res)
        else respond(res, 405, 'Method not allowed', { allow: 'GET, HEAD, POST' })
        return
      }
      if (path === REFRESH_PATH) { await refresh(req, res); return }
      let device = authorize(req, true)
      if (!device) {
        const renewed = await refreshDevice(req)
        device = renewed.device
        requireLive(device)
        req[DEVICE] = device
        req[RENEWAL] = renewed.result
      }
      req[ACCESS_HASH] = device.hash
      trackDevice(device, res)
      if (path === DEVICE_PATH) { await manageDevice(req, res, device); return }
      rewriteRequest(req)
      proxy.web(req, res)
    }).catch(error => respond(res, error instanceof RequestError ? error.status : 500,
      error instanceof RequestError ? error.message : 'Remote request failed'))
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  server.on('connection', socket => track(sockets, socket))
  server.on('upgrade', (req, socket, head) => {
    try {
      const path = checkRequest(req, true)
      if (path === PAIR_PATH || path === DEVICE_PATH || path === REFRESH_PATH) throw new RequestError(403, 'Not a WebSocket endpoint')
      const device = authorize(req)
      track(device.streams, socket)
      rewriteRequest(req)
      proxy.ws(req, socket, head)
    } catch (error) { rejectUpgrade(socket, error instanceof RequestError ? error.status : 500) }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  origin = `http://127.0.0.1:${server.address().port}`

  return {
    origin,
    setExternalOrigin(value) {
      if (closed) throw new Error('Remote bridge is closed')
      const next = externalUrl(value)
      if (external?.origin === next.origin) return
      clearPairing()
      for (const controller of exchanges) controller.abort()
      for (const device of devices.values()) destroyDevice(device)
      external = next
      changed()
    },
    pairing(sessionPath = '/') {
      if (closed || !external) throw new Error('Remote bridge has no active tunnel')
      const location = sessionLocation(sessionPath)
      const secret = randomBytes(32).toString('base64url')
      clearPairing()
      const expiresAt = now() + pairingTtlMs
      pairingState = { hash: digest(secret), expiresAt, sessionPath: location, origin: external.origin }
      pairingTimer = setTimeout(() => { clearPairing(); changed() }, pairingTtlMs)
      pairingTimer.unref()
      changed()
      return { url: `${external.origin}${PAIR_PATH}#secret=${secret}`, expiresAt }
    },
    renameDevice,
    revokeDevice(id) {
      const device = devices.get(id)
      if (!device) return false
      destroyDevice(device)
      changed()
      return true
    },
    snapshot,
    close() {
      if (closing) return closing
      closed = true
      clearPairing()
      for (const controller of exchanges) controller.abort()
      for (const device of devices.values()) destroyDevice(device)
      closing = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        for (const socket of sockets) socket.destroy()
        agent.destroy()
        proxy.close()
      })
      external = undefined
      changed()
      return closing
    },
  }
}
