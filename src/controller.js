import QRCode from 'qrcode';
import { createRemoteBridge, normalizeDeviceLabel } from './bridge.js';
import { checkCloudflared, startQuickTunnel, RemoteControlError } from './tunnel.js';

/** Owns one ephemeral remote-access generation and its paired devices. */
export class RemoteControl {
  constructor(options, dependencies = {}) {
    this.options = options;
    this.createBridge = dependencies.createBridge || createRemoteBridge;
    this.startTunnel = dependencies.startTunnel || startQuickTunnel;
    this.checkDependency = dependencies.checkDependency || checkCloudflared;
    this.renderQr = dependencies.renderQr || (url => QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 256 }));
    this.phase = 'off';
    this.error = null;
    this.publicUrl = null;
    this.pairing = null;
    this.dependency = { available: false };
    this.bridge = null;
    this.tunnel = null;
    this.starting = null;
    this.stopping = null;
    this.abort = null;
    this.disposed = false;
    this.listeners = new Set();
    this.pairingGeneration = 0;
    this.intentGeneration = 0;
    this.releasing = null;
  }

  /** Probe the runtime without opening network access. */
  async initialize() {
    this.dependency = await this.checkDependency(this.options.cloudflaredPath);
    return this.snapshot();
  }

  /** Local UI snapshot; pairing information is deliberately excluded from summary(). */
  snapshot() {
    const bridgeState = this.bridge?.snapshot();
    if (this.pairing && bridgeState?.pairingExpiresAt !== this.pairing.expiresAt) this.pairing = null;
    return {
      phase: this.phase,
      publicUrl: this.publicUrl,
      pairing: this.pairing,
      devices: bridgeState?.devices || [],
      error: this.error,
      dependency: this.dependency,
      local: true,
    };
  }

  /** Agent-visible state contains no pairing secret, QR data, or browser credentials. */
  summary() {
    const { pairing, ...summary } = this.snapshot();
    return { ...summary, pairingAvailable: Boolean(pairing) };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish() {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }

  /** Local user action: establish a tunnel and issue a short-lived pairing code. */
  enable() {
    return this.enableAt(++this.intentGeneration);
  }

  enableAt(intent) {
    if (this.disposed) return Promise.reject(new RemoteControlError('DISPOSED', 'The plugin has been unloaded.'));
    if (intent !== this.intentGeneration) return Promise.resolve(this.snapshot());
    if (this.stopping) return this.stopping.then(() => this.enableAt(intent));
    if (this.phase === 'on') return Promise.resolve(this.snapshot());
    if (this.starting) return this.starting;
    this.phase = 'starting';
    this.error = null;
    this.abort = new AbortController();
    this.publish();
    this.starting = this.runEnable(this.abort.signal).finally(() => { this.starting = null; });
    return this.starting;
  }

  async runEnable(signal) {
    try {
      if (this.releasing) await this.releasing;
      const upstream = new URL(this.options.target);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname)) {
        throw new RemoteControlError('LOOPBACK_REQUIRED', 'Remote control requires a loopback DSH Web listener. Start DSH with --host 127.0.0.1 or --host ::1, then enable remote control again.');
      }
      this.dependency = await this.checkDependency(this.options.cloudflaredPath);
      if (!this.dependency.available) throw new RemoteControlError('CLOUDFLARED_MISSING', 'Install cloudflared on this computer, or configure its executable path.');
      if (signal.aborted) throw new RemoteControlError('CANCELLED', 'Remote access startup was cancelled.');
      const bridge = await this.createBridge({
        target: this.options.target,
        authenticatedUrl: this.options.authenticatedUrl,
        pairingTtlMs: this.options.pairingTtlSeconds * 1000,
        deviceTtlMs: Math.round(this.options.deviceTtlHours * 3600000),
        refreshTtlMs: Math.round(this.options.refreshTtlDays * 86400000),
        refreshAheadMs: this.options.refreshAheadSeconds * 1000,
        refreshRetryMs: this.options.refreshRetrySeconds * 1000,
        maxDevices: this.options.maxDevices,
        onChange: () => this.publish(),
      });
      this.bridge = bridge;
      if (signal.aborted) throw new RemoteControlError('CANCELLED', 'Remote access startup was cancelled.');
      let tunnelFailure = null;
      const tunnel = await this.startTunnel({
        binary: this.options.cloudflaredPath,
        origin: bridge.origin,
        protocol: this.options.tunnelProtocol,
        timeoutMs: this.options.startupTimeoutSeconds * 1000,
        signal,
        onExit: error => {
          tunnelFailure = error;
          if (this.bridge === bridge && this.phase === 'on') void this.fail(error);
        },
      });
      this.tunnel = tunnel;
      if (tunnelFailure) throw tunnelFailure;
      if (signal.aborted) throw new RemoteControlError('CANCELLED', 'Remote access startup was cancelled.');
      bridge.setExternalOrigin(tunnel.publicUrl);
      this.publicUrl = tunnel.publicUrl;
      this.phase = 'on';
      await this.issuePair();
      return this.snapshot();
    } catch (error) {
      let failure = error;
      try { await this.release(); }
      catch (cleanupError) { failure = cleanupError; }
      if (failure.code === 'CLEANUP_FAILED' || (!signal.aborted && !this.disposed)) {
        this.phase = 'error';
        this.error = safeError(failure);
        this.publish();
      }
      if (signal.aborted && failure.code !== 'CLEANUP_FAILED') return this.snapshot();
      throw failure;
    }
  }

  /** Close the proxy first so revocation takes effect even while the tunnel is draining. */
  disable() {
    ++this.intentGeneration;
    if (this.stopping) return this.stopping;
    const startup = this.starting;
    this.abort?.abort();
    this.phase = 'stopping';
    this.pairing = null;
    this.publicUrl = null;
    this.error = null;
    this.publish();
    this.stopping = (async () => {
      await this.release();
      if (startup) await startup.catch(() => {});
      // Startup may have been between allocating a resource and publishing it when cancelled.
      await this.release();
      this.phase = 'off';
      this.publish();
      return this.snapshot();
    })().catch(error => {
      this.phase = 'error';
      this.error = safeError(error);
      this.publish();
      throw error;
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }

  /** Replace the previous unused QR code; only the local UI can call this action. */
  async issuePair() {
    if (this.phase !== 'on' || !this.bridge) throw new RemoteControlError('NOT_RUNNING', 'Enable remote access before pairing a device.');
    const bridge = this.bridge;
    const generation = ++this.pairingGeneration;
    this.pairing = null;
    const pair = bridge.pairing('/');
    const svg = await this.renderQr(pair.url);
    if (generation !== this.pairingGeneration || this.phase !== 'on' || this.bridge !== bridge || bridge.snapshot().pairingExpiresAt !== pair.expiresAt) {
      return this.snapshot();
    }
    this.pairing = { ...pair, qrSvg: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
    this.publish();
    return this.snapshot();
  }

  /** Rename a paired device without changing its credentials or connections. */
  renameDevice(id, value) {
    if (typeof id !== 'string' || !id) throw new RemoteControlError('INVALID_DEVICE', 'Choose a paired device.');
    let label;
    try { label = normalizeDeviceLabel(value); }
    catch (error) { throw new RemoteControlError('INVALID_REQUEST', error.message); }
    if (!this.bridge?.renameDevice(id, label)) throw new RemoteControlError('DEVICE_NOT_FOUND', 'The device is no longer paired.');
    this.publish();
    return this.snapshot();
  }

  /** Revoke only this device and close its active connections. */
  revokeDevice(id) {
    if (typeof id !== 'string' || !id) throw new RemoteControlError('INVALID_DEVICE', 'Choose a paired device.');
    if (!this.bridge?.revokeDevice(id)) throw new RemoteControlError('DEVICE_NOT_FOUND', 'The device is no longer paired.');
    this.publish();
    return this.snapshot();
  }

  async fail(error) {
    if (this.phase !== 'on') return;
    this.phase = 'error';
    this.error = safeError(error);
    this.pairing = null;
    this.publicUrl = null;
    try {
      await this.release();
    } catch (cleanupError) {
      this.error = safeError(cleanupError);
    }
    this.publish();
  }

  async release() {
    const bridge = this.bridge;
    const tunnel = this.tunnel;
    this.bridge = null;
    this.tunnel = null;
    this.pairing = null;
    this.publicUrl = null;
    if (!bridge && !tunnel) {
      if (this.releasing) await this.releasing;
      return;
    }
    const previous = this.releasing;
    const cleanup = Promise.allSettled([
      previous,
      Promise.resolve().then(() => bridge?.close()),
      Promise.resolve().then(() => tunnel?.stop()),
    ]).then(results => {
      if (results.some(result => result.status === 'rejected')) {
        throw new RemoteControlError('CLEANUP_FAILED', 'A remote-access resource could not be closed. Restart DSH before enabling remote access again.');
      }
    });
    this.releasing = cleanup;
    await cleanup;
    if (this.releasing === cleanup) this.releasing = null;
  }

  async close() {
    this.disposed = true;
    await this.disable();
    this.listeners.clear();
  }
}

/** Keep unexpected exception details and credentials out of public responses. */
export function safeError(error) {
  return error instanceof RemoteControlError
    ? { code: error.code, message: error.message }
    : { code: 'REMOTE_CONTROL_FAILED', message: 'The remote-access operation failed. Please retry.' };
}
