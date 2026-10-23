import { spawn } from 'node:child_process';
import { get } from 'node:https';
import { RemoteControlError } from './tunnel.js';

const HEALTH_TIMEOUT = 5000;
const HEALTH_INTERVAL = 5000;
const STARTUP_POLL_INTERVAL = 500;
const messages = {
  CANCELLED: 'Remote access startup was cancelled.',
  SSH_CONFIG_INVALID: 'The SSH tunnel configuration is invalid.',
  SSH_MISSING: 'ssh is not installed or its configured path is unavailable.',
  SSH_SPAWN_FAILED: 'Could not start ssh.',
  SSH_AUTH_FAILED: 'SSH authentication failed. Check the dedicated SSH identity and account.',
  SSH_HOST_KEY_FAILED: 'SSH host verification failed. Check the dedicated known-hosts configuration.',
  SSH_FORWARD_FAILED: 'SSH could not open the dedicated remote forwarding port.',
  SSH_EXITED: 'The SSH connection stopped.',
  SSH_TIMEOUT: 'The SSH tunnel did not become healthy in time.',
  SSH_HEALTH_TIMEOUT: 'The public remote-access health check timed out.',
  SSH_HEALTH_UNREACHABLE: 'The public remote-access health endpoint is unavailable.',
  SSH_HEALTH_INVALID: 'The public remote-access health response is invalid.',
  SSH_HEALTH_ENTRY_MISMATCH: 'The public remote-access endpoint belongs to another entry.',
};
const failure = code => new RemoteControlError(code, messages[code]);

function configuration({ binary, target, configPath, origin, publicUrl, remotePort, expectedEntryId, timeoutMs }) {
  try {
    if (typeof binary !== 'string' || !binary || binary.includes('\0')
      || typeof target !== 'string' || target.length > 253
      || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(target)
      || (configPath !== undefined && (typeof configPath !== 'string' || !configPath || configPath.includes('\0')))
      || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535
      || typeof expectedEntryId !== 'string' || !expectedEntryId || expectedEntryId.length > 512
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure('SSH_CONFIG_INVALID');
    const local = new URL(origin);
    const external = new URL(publicUrl);
    if (local.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname)
      || local.username || local.password || local.pathname !== '/' || local.search || local.hash
      || external.protocol !== 'https:' || external.username || external.password
      || external.pathname !== '/' || external.search || external.hash) throw failure('SSH_CONFIG_INVALID');
    return { publicUrl: external.origin, healthUrl: `${external.origin}/__dsh_remote_health`,
      forward: `127.0.0.1:${remotePort}:${local.hostname}:${local.port || '80'}` };
  } catch {
    throw failure('SSH_CONFIG_INVALID');
  }
}

/** HTTPS only: system CA verification stays enabled, redirects and oversized bodies fail closed. */
export function probePublicHealth(url, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const request = get(url, { signal, timeout: timeoutMs, rejectUnauthorized: true,
      headers: { accept: 'application/json' } }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(failure('SSH_HEALTH_UNREACHABLE'));
        return;
      }
      let body = '';
      let size = 0;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 8192) {
          reject(failure('SSH_HEALTH_INVALID'));
          response.destroy();
        } else body += chunk;
      });
      response.once('error', () => reject(failure('SSH_HEALTH_UNREACHABLE')));
      response.once('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(failure('SSH_HEALTH_INVALID')); }
      });
    });
    request.once('timeout', () => request.destroy(failure('SSH_HEALTH_TIMEOUT')));
    request.once('error', error => reject(error instanceof RemoteControlError
      ? error : failure('SSH_HEALTH_UNREACHABLE')));
  });
}

/** Match fixed diagnostic tokens across chunks, retaining only positions, never stderr text. */
function diagnosticReader(notify) {
  const tokens = [
    ['remote forward success for:', 'forwarded'],
    ['permission denied', 'SSH_AUTH_FAILED'],
    ['authentication failed', 'SSH_AUTH_FAILED'],
    ['too many authentication failures', 'SSH_AUTH_FAILED'],
    ['host key verification failed', 'SSH_HOST_KEY_FAILED'],
    ['remote host identification has changed', 'SSH_HOST_KEY_FAILED'],
    ['remote port forwarding failed', 'SSH_FORWARD_FAILED'],
    ['remote forward failure', 'SSH_FORWARD_FAILED'],
  ];
  const positions = tokens.map(() => 0);
  return chunk => {
    for (const character of String(chunk).toLowerCase()) {
      for (let index = 0; index < tokens.length; index++) {
        const [token, result] = tokens[index];
        let position = positions[index];
        position = character === token[position] ? position + 1 : character === token[0] ? 1 : 0;
        if (position === token.length) { position = 0; notify(result); }
        positions[index] = position;
      }
    }
  };
}

/** Probe only the configured executable; no config, identity, or network connection is opened. */
export async function checkSsh(binary = 'ssh', timeoutMs = 3000, spawnProcess = spawn) {
  return new Promise(resolve => {
    let child;
    let timer;
    let settled = false;
    const finish = available => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available });
    };
    try { child = spawnProcess(binary, ['-V'], { stdio: 'ignore', windowsHide: true }); }
    catch { finish(false); return; }
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0));
    timer = setTimeout(() => { child.kill('SIGKILL'); finish(false); }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * Own one SSH connection at a time. First readiness needs this connection's forwarding ACK
 * and matching public health. Once ready, failures are reported through onHealth and retried;
 * onExit is deliberately not called for recoverable child exits (the bridge remains owned).
 * probe(url, { signal, timeoutMs, expectedEntryId }) may return the health JSON or a Response.
 * checkedAt/retryAt are Unix milliseconds. stop() is idempotent and joins owned children.
 */
export async function startSshTunnel({ binary = 'ssh', target, configPath, origin, publicUrl,
  remotePort, expectedEntryId, timeoutMs = 30000, signal, onExit: _onExit, onHealth,
  spawnProcess = spawn, probe = probePublicHealth }) {
  if (signal?.aborted) throw failure('CANCELLED');
  const config = configuration({ binary, target, configPath, origin, publicUrl,
    remotePort, expectedEntryId, timeoutMs });
  const args = [...(configPath === undefined ? [] : ['-F', configPath]), '-NT', '-v',
    '-oBatchMode=yes', '-oExitOnForwardFailure=yes', '-oServerAliveInterval=15',
    '-oServerAliveCountMax=3', '-oConnectTimeout=10', '-S', 'none', '-oControlMaster=no',
    '-R', config.forward, target];
  let stopping = false;
  let ready = false;
  let settled = false;
  let current;
  let startupTimer;
  let retryTimer;
  let backoff = 1000;
  let stopPromise;
  let health;
  const owned = new Set();
  let resolveReady;
  let rejectReady;
  const readiness = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  const getHealth = () => health && { ...health, ...(health.error ? { error: { ...health.error } } : {}) };
  function report(status, error, retryAt) {
    health = { status, checkedAt: Date.now(),
      ...(error ? { error: { code: error.code, message: messages[error.code] || messages.SSH_EXITED } } : {}),
      ...(retryAt !== undefined ? { retryAt } : {}) };
    try { onHealth?.(getHealth()); } catch { /* Observers do not own transport cleanup. */ }
  }
  function failInitial(error) {
    if (settled || stopping) return;
    settled = true;
    report('offline', error);
    rejectReady(error);
    void stop(false);
  }
  async function dispose(attempt) {
    if (attempt.disposePromise) return attempt.disposePromise;
    attempt.closing = true;
    clearTimeout(attempt.timer);
    clearTimeout(attempt.pollTimer);
    attempt.probeAbort?.abort();
    attempt.disposePromise = (async () => {
      // Abort may occur inside an injected spawn before it hands us the child.
      await attempt.acquired;
      if (attempt.child && !attempt.closed) {
        try { attempt.child.kill('SIGTERM'); } catch { /* Still join the close event. */ }
        attempt.killTimer = setTimeout(() => {
          try { attempt.child.kill('SIGKILL'); } catch { /* The close event remains authoritative. */ }
        }, 2000);
        attempt.killTimer.unref?.();
        await attempt.joined;
      }
      clearTimeout(attempt.killTimer);
      await attempt.probeTask;
      attempt.child?.stderr?.removeListener('data', attempt.readDiagnostic);
      owned.delete(attempt);
    })();
    return attempt.disposePromise;
  }
  function stop(reportStopped = true) {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearTimeout(startupTimer);
    clearTimeout(retryTimer);
    signal?.removeEventListener('abort', abort);
    if (!settled) { settled = true; rejectReady(failure('CANCELLED')); }
    stopPromise = Promise.all([...owned].map(dispose)).then(() => undefined);
    if (reportStopped) report('offline');
    return stopPromise;
  }
  function abort() { void stop(); }
  function scheduleRetry(error) {
    if (stopping) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, 30000);
    report(['SSH_AUTH_FAILED', 'SSH_HOST_KEY_FAILED'].includes(error.code) ? 'offline' : 'reconnecting',
      error, Date.now() + delay);
    if (stopping) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; if (!stopping) startAttempt(); }, delay);
    retryTimer.unref?.();
  }
  async function lost(attempt, error) {
    if (stopping || attempt.closing || current !== attempt) return;
    if (!ready) { failInitial(error); return; }
    report('reconnecting', error);
    await dispose(attempt);
    if (!stopping && current === attempt) { current = undefined; scheduleRetry(error); }
  }
  function poll(attempt, delay) {
    if (stopping || attempt.closing || current !== attempt) return;
    attempt.pollTimer = setTimeout(() => check(attempt), delay);
    attempt.pollTimer.unref?.();
  }
  function check(attempt) {
    if (stopping || attempt.closing || !attempt.alive || !attempt.forwarded
      || current !== attempt || attempt.probeTask) return;
    const controller = new AbortController();
    attempt.probeAbort = controller;
    let timedOut = false;
    let cancel;
    const cancelled = new Promise((resolve, reject) => {
      cancel = () => reject(failure(timedOut ? 'SSH_HEALTH_TIMEOUT' : 'CANCELLED'));
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    const probeTimeout = setTimeout(() => { timedOut = true; controller.abort(); }, HEALTH_TIMEOUT);
    probeTimeout.unref?.();
    attempt.probeTask = (async () => {
      try {
        let result = await Promise.race([Promise.resolve().then(() => {
          if (stopping || attempt.closing || controller.signal.aborted) throw failure('CANCELLED');
          return probe(config.healthUrl, { signal: controller.signal, timeoutMs: HEALTH_TIMEOUT, expectedEntryId });
        }), cancelled]);
        if (stopping || attempt.closing || current !== attempt || !attempt.alive) return;
        if (result && typeof result.json === 'function') {
          if (!result.ok) throw failure('SSH_HEALTH_UNREACHABLE');
          result = await Promise.race([result.json(), cancelled]);
        }
        if (stopping || attempt.closing || current !== attempt || !attempt.alive) return;
        if (!result || result.ok !== true || result.service !== 'dsh-remote-control') throw failure('SSH_HEALTH_INVALID');
        if (result.entryId !== expectedEntryId) throw failure('SSH_HEALTH_ENTRY_MISMATCH');
        clearTimeout(attempt.timer);
        backoff = 1000;
        report('online');
        if (stopping || attempt.closing || !attempt.alive) return;
        if (!ready) {
          ready = true;
          settled = true;
          clearTimeout(startupTimer);
          resolveReady({ publicUrl: config.publicUrl, stop, getHealth });
        }
        poll(attempt, HEALTH_INTERVAL);
      } catch (error) {
        if (stopping || attempt.closing || current !== attempt || !attempt.alive) return;
        const safeError = error instanceof RemoteControlError && messages[error.code]
          ? error : failure('SSH_HEALTH_UNREACHABLE');
        if (!ready) { report('reconnecting', safeError); poll(attempt, STARTUP_POLL_INTERVAL); }
        else queueMicrotask(() => { void lost(attempt, safeError); });
      } finally {
        clearTimeout(probeTimeout);
        controller.signal.removeEventListener('abort', cancel);
        controller.abort();
        attempt.probeAbort = undefined;
        attempt.probeTask = undefined;
      }
    })();
  }
  function startAttempt() {
    if (stopping) return;
    let acquired;
    let joined;
    const attempt = { alive: true, closed: false, forwarded: false, closing: false,
      acquired: new Promise(resolve => { acquired = resolve; }),
      joined: new Promise(resolve => { joined = resolve; }) };
    current = attempt;
    owned.add(attempt);
    const exited = () => {
      if (stopping || attempt.closing) return;
      void lost(attempt, attempt.failure || failure('SSH_EXITED'));
    };
    try {
      attempt.child = spawnProcess(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      attempt.child.once('error', error => {
        attempt.alive = false;
        attempt.failure = failure(error.code === 'ENOENT' ? 'SSH_MISSING' : 'SSH_SPAWN_FAILED');
        if (!attempt.child.pid) { attempt.closed = true; joined(); }
        exited();
      });
      attempt.child.once('exit', () => { attempt.alive = false; exited(); });
      attempt.child.once('close', () => {
        attempt.alive = false;
        attempt.closed = true;
        clearTimeout(attempt.killTimer);
        joined();
        exited();
      });
      attempt.readDiagnostic = diagnosticReader(result => {
        if (stopping || attempt.closing || current !== attempt || !attempt.alive) return;
        if (result === 'forwarded') {
          attempt.forwarded = true;
          queueMicrotask(() => check(attempt));
        } else {
          attempt.failure = failure(result);
          void lost(attempt, attempt.failure);
        }
      });
      attempt.child.stderr?.setEncoding('utf8');
      attempt.child.stderr?.on('data', attempt.readDiagnostic);
      if (ready && !stopping && !attempt.closing) {
        attempt.timer = setTimeout(() => { void lost(attempt, failure('SSH_TIMEOUT')); }, timeoutMs);
        attempt.timer.unref?.();
      }
    } catch (error) {
      attempt.alive = false;
      attempt.closed = true;
      joined();
      attempt.failure = failure(error?.code === 'ENOENT' ? 'SSH_MISSING' : 'SSH_SPAWN_FAILED');
      exited();
    } finally { acquired(); }
    if (stopping) void dispose(attempt);
  }

  signal?.addEventListener('abort', abort, { once: true });
  startupTimer = setTimeout(() => failInitial(failure('SSH_TIMEOUT')), timeoutMs);
  startupTimer.unref?.();
  report('reconnecting');
  // An observer can abort synchronously while receiving the initial health notification.
  if (signal?.aborted) abort();
  if (!stopping) startAttempt();
  try { return await readiness; }
  catch (error) { await stop(false); throw error; }
}
