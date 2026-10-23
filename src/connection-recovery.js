/**
 * Refresh HttpOnly credentials once per Core outage before nudging its existing retry loop.
 * Keep all dependencies inside this function: the Client embeds it using .toString().
 * The credential renewer owns network retries; notifyCredentialState receives its onState.
 */
export function createConnectionCredentialRecovery({
  connection,
  refresh,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
} = {}) {
  if (typeof connection?.state?.getSnapshot !== 'function'
    || typeof connection?.state?.subscribe !== 'function'
    || typeof connection?.reconnect !== 'function' || typeof refresh !== 'function') {
    throw new TypeError('A Core connection and credential refresh function are required');
  }
  const GRACE_MS = 900;
  let started = false;
  let disposed = false;
  let unsubscribe;
  let timer;
  let outage;
  let inFlight;

  function snapshot() {
    try { return connection.state.getSnapshot(); } catch { return undefined; }
  }
  function clearTimer() {
    if (timer !== undefined) cancelTimeout(timer);
    timer = undefined;
  }
  function current(attempt) {
    return started && !disposed && outage === attempt;
  }
  function reconnectIfReady(attempt) {
    if (!current(attempt) || !attempt.ready || attempt.expired || attempt.reconnectIssued) return;
    const state = snapshot();
    if (state === 'connected') { connectionChanged(); return; }
    if (state !== 'connecting') return;
    // Claim the only nudge before calling Core: reconnect may synchronously publish state.
    attempt.reconnectIssued = true;
    attempt.ready = false;
    try { connection.reconnect(); } catch { /* Core owns subsequent connection retries. */ }
  }
  function credentialState(attempt, next) {
    if (!current(attempt) || !attempt.refreshInvoked || attempt.expired || attempt.reconnectIssued) return;
    if (next?.phase === 'expired') {
      attempt.expired = true;
      attempt.ready = false;
    } else if (next?.phase === 'ready') {
      attempt.ready = true;
      reconnectIfReady(attempt);
    } else {
      // Retain this outage while the existing renewer checks or retries the network.
      attempt.ready = false;
    }
  }
  function requestRecovery(attempt) {
    if (!current(attempt) || attempt.refreshStarted || snapshot() !== 'connecting') return;
    // An earlier outage may still own a shared renewer request. Its finally will reschedule.
    if (inFlight) return;
    attempt.refreshStarted = true;
    const operation = Promise.resolve().then(() => {
      if (!current(attempt)) return;
      if (snapshot() !== 'connecting') { attempt.refreshStarted = false; return; }
      attempt.refreshInvoked = true;
      return refresh();
    }).then(next => {
      credentialState(attempt, next);
    }, () => {
      // A rejected refresh is retryable by the renewer, never a second helper request.
      credentialState(attempt, { phase: 'retrying' });
    }).finally(() => {
      if (inFlight !== operation) return;
      inFlight = undefined;
      if (!disposed) connectionChanged();
    });
    // Set the shared operation before invoking refresh or any observer can reenter.
    inFlight = operation;
  }
  function connectionChanged() {
    if (!started || disposed) return;
    const state = snapshot();
    if (state === 'connected') {
      clearTimer();
      outage = undefined;
      return;
    }
    if (state !== 'connecting') {
      clearTimer();
      return;
    }
    if (!outage) outage = { refreshStarted: false, refreshInvoked: false,
      ready: false, reconnectIssued: false, expired: false };
    const attempt = outage;
    reconnectIfReady(attempt);
    if (!current(attempt) || attempt.refreshStarted || timer !== undefined) return;
    timer = scheduleTimeout(() => {
      timer = undefined;
      requestRecovery(attempt);
    }, GRACE_MS);
  }
  function start() {
    if (started || disposed) return;
    started = true;
    const stopListening = connection.state.subscribe(connectionChanged);
    // A synchronous subscription callback may dispose the helper before subscribe returns.
    if (disposed) { if (typeof stopListening === 'function') stopListening(); return; }
    unsubscribe = stopListening;
    connectionChanged();
  }
  function notifyCredentialState(next) {
    if (disposed || !started || !outage) return;
    credentialState(outage, next);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimer();
    outage = undefined;
    const stopListening = unsubscribe;
    unsubscribe = undefined;
    if (typeof stopListening === 'function') stopListening();
  }
  return { start, notifyCredentialState, dispose };
}
