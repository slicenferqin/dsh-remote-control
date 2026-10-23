/** Self-contained: pairingPage embeds this function without browser module imports. */
export function createPairingResumer({
  fetch: requestFetch,
  location: browserLocation,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
  onState = () => {},
} = {}) {
  let started = false
  let inFlight
  let state = { phase: 'idle', error: null }

  function publish(phase, error = null) {
    state = { phase, error }
    onState(state)
    return state
  }

  function attempt() {
    if (inFlight) return inFlight
    if (state.phase === 'ready') return Promise.resolve(state)
    inFlight = Promise.resolve().then(async () => {
      const controller = new AbortController()
      const signal = controller.signal
      const failure = code => Object.assign(new Error('Pairing recovery failed'), { code })
      let rejectAbort
      const aborted = new Promise((resolve, reject) => { rejectAbort = reject })
      const abort = () => rejectAbort(failure('request_timeout'))
      signal.addEventListener('abort', abort, { once: true })
      const timer = scheduleTimeout(() => controller.abort(), 30_000)
      async function request(path, method) {
        if (signal.aborted) throw failure('request_timeout')
        const response = await requestFetch(path, {
          method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
          headers: { Accept: 'application/json', ...(method === 'POST'
            ? { 'Content-Type': 'application/json' } : { 'X-DSH-Remote-Confirm': '1' }) },
          ...(method === 'POST' ? { body: '{}' } : {}),
        })
        if (signal.aborted) throw failure('request_timeout')
        if (!response.ok) throw failure([401, 403].includes(response.status) ? 'credentials_required' : 'network_error')
        let value
        try { value = await response.json() } catch { throw failure('invalid_response') }
        if (signal.aborted) throw failure('request_timeout')
        if (!value || typeof value.id !== 'string' || !value.id
          || !['expiresAt', 'refreshExpiresAt', 'serverTime'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) {
          throw failure('invalid_response')
        }
        if (value.expiresAt <= value.serverTime || value.refreshExpiresAt <= value.serverTime) throw failure('credentials_required')
        return value.id
      }
      try {
        publish('checking')
        const operation = (async () => {
          const refreshedId = await request('/__dsh_remote_refresh', 'POST')
          // This separate request confirms the browser applied the HttpOnly cookies.
          const confirmedId = await request('/__dsh_remote_device', 'GET')
          if (refreshedId !== confirmedId) throw failure('invalid_response')
        })()
        await Promise.race([operation, aborted])
        if (signal.aborted) throw failure('request_timeout')
        browserLocation.replace('/')
        return publish('ready')
      } catch (error) {
        const known = ['request_timeout', 'credentials_required', 'invalid_response']
        return publish('failed', known.includes(error?.code) ? error.code : 'network_error')
      } finally {
        cancelTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
    }).finally(() => { inFlight = undefined })
    return inFlight
  }

  return {
    start() {
      if (started) return inFlight || Promise.resolve(state)
      started = true
      return attempt()
    },
    retry() {
      started = true
      return attempt()
    },
  }
}
