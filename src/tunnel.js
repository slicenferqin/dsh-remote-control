import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** A bounded failure safe to show without exposing subprocess output or credentials. */
export class RemoteControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RemoteControlError';
    this.code = code;
  }
}

/** Probe only the configured executable, without opening a tunnel. */
export async function checkCloudflared(binary, timeoutMs = 3000) {
  return new Promise(resolve => {
    let finished = false;
    let child;
    let timer;
    const finish = available => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ available });
    };
    try {
      child = spawn(binary, ['--version'], { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      // Spawn may fail synchronously for an invalid executable argument.
      finish(false);
      return;
    }
    child.once('error', () => finish(false));
    child.once('exit', code => finish(code === 0));
    timer = setTimeout(() => { child.kill('SIGKILL'); finish(false); }, timeoutMs);
    timer.unref?.();
  });
}

/** Start one owned Quick Tunnel; readiness requires both a hostname and an edge connection. */
export async function startQuickTunnel({ binary, origin, timeoutMs, protocol, signal, onExit, spawnProcess = spawn }) {
  if (signal?.aborted) throw new RemoteControlError('CANCELLED', 'Remote access startup was cancelled.');
  const config = fileURLToPath(new URL('./cloudflared.yml', import.meta.url));
  const args = ['tunnel', '--config', config, '--no-autoupdate', '--url', origin,
    '--protocol', protocol, '--metrics', '127.0.0.1:0', '--grace-period', '1s',
    '--loglevel', 'info', '--output', 'json'];
  // An existing named-tunnel environment must never select credentials or a different origin.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('TUNNEL_') && !key.startsWith('CF_TUNNEL_')));
  const child = spawnProcess(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  let stopping = false;
  let settled = false;
  let ready = false;
  let publicUrl;
  let connected = false;
  let timer;
  let resolveReady;
  let rejectReady;
  let resolveClosed;
  let closeTimer;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const readiness = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const removeAbort = () => signal?.removeEventListener('abort', abort);
  const fail = error => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectReady(error);
  };
  const abort = () => {
    fail(new RemoteControlError('CANCELLED', 'Remote access startup was cancelled.'));
    void stop();
  };
  async function stop() {
    if (!stopping) {
      stopping = true;
      clearTimeout(timer);
      removeAbort();
      if (!settled) fail(new RemoteControlError('CANCELLED', 'Remote access startup was cancelled.'));
      child.kill('SIGTERM');
      closeTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      closeTimer.unref?.();
    }
    await closed;
    clearTimeout(closeTimer);
  }
  function readLine(line) {
    let message = line;
    try {
      const record = JSON.parse(line);
      message = typeof record.message === 'string' ? record.message : line;
    } catch (error) {
      // cloudflared also prints a plain-text hostname banner with JSON logging enabled.
    }
    const found = message.match(/https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com\b/i);
    if (found) publicUrl = found[0].toLowerCase();
    if (/Registered tunnel connection/i.test(message)) connected = true;
    if (!settled && publicUrl && connected) {
      ready = true;
      settled = true;
      clearTimeout(timer);
      removeAbort();
      resolveReady({ publicUrl, stop });
    }
  }
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        readLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      // Keep subprocess output bounded, and never retain or publish a log transcript.
      if (pending.length > 8192) pending = pending.slice(-8192);
    });
    stream.once('end', () => { if (pending) readLine(pending); });
  }
  child.once('error', error => {
    fail(new RemoteControlError(error.code === 'ENOENT' ? 'CLOUDFLARED_MISSING' : 'TUNNEL_SPAWN_FAILED',
      error.code === 'ENOENT' ? 'cloudflared is not installed or its configured path is unavailable.' : 'Could not start cloudflared.'));
    resolveClosed();
  });
  child.once('close', (code, exitSignal) => {
    clearTimeout(timer);
    clearTimeout(closeTimer);
    removeAbort();
    resolveClosed();
    if (!stopping) {
      const error = new RemoteControlError('TUNNEL_EXITED', `The tunnel stopped (${exitSignal || code || 'unknown'}).`);
      fail(error);
      if (ready) onExit?.(error);
    }
  });
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => {
    fail(new RemoteControlError('TUNNEL_TIMEOUT', 'Could not establish the Cloudflare tunnel in time. Check this computer’s network connection.'));
    void stop();
  }, timeoutMs);
  timer.unref?.();
  try {
    return await readiness;
  } catch (error) {
    await stop();
    throw error;
  }
}
