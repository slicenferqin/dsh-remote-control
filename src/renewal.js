/**
 * Renew HttpOnly browser credentials using server-provided relative delays.
 * Keep every dependency and helper inside this function: build-client.js embeds
 * its source directly in the lazy Client factory without runtime module imports.
 */
export function createCredentialRenewer({
  fetch: requestFetch,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
  window: browserWindow = globalThis.window,
  document: browserDocument = globalThis.document,
  locks = browserWindow?.navigator?.locks,
  onState = () => {},
} = {}) {
  if (typeof requestFetch !== 'function') throw new TypeError('fetch must be a function');
  const REQUEST_TIMEOUT_MS = 30_000;
  const MAX_TIMER_MS = 2 ** 31 - 1;
  let retryMs = 30_000;
  let state = { phase: 'idle', device: null, error: null };
  let started = false;
  let disposed = false;
  let stopped = false;
  let timer;
  let requestTimeout;
  let controller;
  let inFlight;
  let listening = false;

  function publish(phase, device = state.device, error = null) {
    if (disposed) return;
    state = { phase, device, error };
    onState(state);
  }
  function clearTimer() {
    if (timer !== undefined) cancelTimeout(timer);
    timer = undefined;
  }
  function clearRequestTimeout() {
    if (requestTimeout !== undefined) cancelTimeout(requestTimeout);
    requestTimeout = undefined;
  }
  function isHidden() {
    return browserDocument?.visibilityState === 'hidden';
  }
  function wake() {
    if (!disposed && !stopped) void refresh();
  }
  function visibilityChanged() {
    if (!isHidden()) wake();
  }
  function removeListeners() {
    if (!listening) return;
    listening = false;
    browserWindow?.removeEventListener('online', wake);
    browserWindow?.removeEventListener('pageshow', wake);
    browserDocument?.removeEventListener('visibilitychange', visibilityChanged);
  }
  function schedule(delay) {
    clearTimer();
    if (disposed || stopped) return;
    timer = scheduleTimeout(() => {
      timer = undefined;
      // A suspended tab may wait; each foreground event attempts renewal again.
      if (!isHidden()) void refresh();
    }, Math.max(1000, Math.min(delay, MAX_TIMER_MS)));
  }
  function metadata(value) {
    if (!value || typeof value.id !== 'string' || typeof value.label !== 'string'
      || !['pairedAt', 'expiresAt', 'refreshExpiresAt', 'serverTime'].every(key => Number.isFinite(value[key]))
      || !Number.isFinite(value.refreshAfterMs) || value.refreshAfterMs < 0
      || !Number.isFinite(value.refreshRetryMs) || value.refreshRetryMs <= 0) {
      throw Object.assign(new Error('Invalid credential metadata'), { code: 'invalid_response' });
    }
    // Only metadata crosses this boundary; credential cookies stay browser-owned.
    return {
      id: value.id, label: value.label, pairedAt: value.pairedAt,
      expiresAt: value.expiresAt, refreshExpiresAt: value.refreshExpiresAt,
      serverTime: value.serverTime, refreshAfterMs: value.refreshAfterMs,
      refreshRetryMs: value.refreshRetryMs,
    };
  }
  function request(method) {
    if (disposed || stopped) return Promise.resolve(state);
    if (inFlight) return inFlight;
    clearTimer();
    controller = new AbortController();
    const signal = controller.signal;
    // Assign the shared promise before fetch or observers can trigger a wake.
    inFlight = Promise.resolve().then(async () => {
      let rejectAbort;
      const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
      const abort = () => rejectAbort(Object.assign(new Error('Credential request aborted'), { code: 'aborted' }));
      signal.addEventListener('abort', abort, { once: true });
      let timedOut = false;
      requestTimeout = scheduleTimeout(() => {
        timedOut = true;
        controller?.abort();
      }, REQUEST_TIMEOUT_MS);
      try {
        publish('checking');
        async function exchange() {
          if (disposed || signal.aborted) throw Object.assign(new Error('Credential request aborted'), { code: 'aborted' });
          const response = await requestFetch(method === 'GET' ? '/__dsh_remote_device' : '/__dsh_remote_refresh', {
            method,
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'error',
            headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
            ...(method === 'POST' ? { body: '{}' } : {}),
            signal,
          });
          if (!response.ok) throw Object.assign(new Error(`Credential request failed: ${response.status}`), { status: response.status });
          return metadata(await response.json());
        }
        const operation = Promise.resolve().then(() => method === 'POST' && typeof locks?.request === 'function'
          ? locks.request('dsh-remote-control.credentials', { mode: 'exclusive', signal }, exchange)
          : exchange());
        const device = await Promise.race([operation, aborted]);
        if (disposed || stopped || signal.aborted) return state;
        retryMs = device.refreshRetryMs;
        publish('ready', device);
        schedule(device.refreshAfterMs);
      } catch (error) {
        if (disposed || stopped) return state;
        if (error?.status === 401 || error?.status === 403) {
          stopped = true;
          clearTimer();
          removeListeners();
          publish('expired', null, { code: 'credentials_expired', status: error.status });
        } else {
          publish('retrying', state.device, { code: timedOut ? 'request_timeout' : error?.code || 'network_error', ...(error?.status ? { status: error.status } : {}) });
          schedule(retryMs);
        }
      } finally {
        signal.removeEventListener('abort', abort);
        clearRequestTimeout();
        controller = undefined;
      }
      return state;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }
  function start() {
    if (disposed || stopped || started) return inFlight || Promise.resolve(state);
    started = true;
    listening = true;
    browserWindow?.addEventListener('online', wake);
    browserWindow?.addEventListener('pageshow', wake);
    browserDocument?.addEventListener('visibilitychange', visibilityChanged);
    return request('GET');
  }
  function refresh() {
    if (!started) return start();
    return request('POST');
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimer();
    clearRequestTimeout();
    removeListeners();
    controller?.abort();
  }
  return { start, refresh, dispose };
}
