import QRCode from 'qrcode';
import { createRemoteBridge, normalizeDeviceLabel } from './bridge.js';
import { checkCloudflared, startQuickTunnel, RemoteControlError } from './tunnel.js';
import { checkSsh, startSshTunnel, probePublicHealth } from './ssh-tunnel.js';

/** Owns a gated local bridge and one reconnecting outbound carrier. */
export class RemoteControl {
  constructor(options, dependencies = {}) {
    this.options = options;
    this.mode = options.tunnelMode === 'ssh' ? 'ssh' : 'quick';
    this.createBridge = dependencies.createBridge || createRemoteBridge;
    this.startTunnel = dependencies.startTunnel || (this.mode === 'ssh' ? startSshTunnel : startQuickTunnel);
    this.checkDependency = dependencies.checkDependency || (this.mode === 'ssh' ? checkSsh : checkCloudflared);
    this.probe = dependencies.probe || probePublicHealth;
    this.schedule = dependencies.setTimeout || setTimeout;
    this.cancel = dependencies.clearTimeout || clearTimeout;
    this.renderQr = dependencies.renderQr || (url => QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 256 }));
    this.phase = 'off';
    this.error = null;
    this.publicUrl = null;
    this.pairing = null;
    this.dependency = { available: false };
    this.connection = { status: 'offline', checkedAt: null };
    this.bridge = null;
    this.tunnel = null;
    this.starting = null;
    this.stopping = null;
    this.abort = null;
    this.disposed = false;
    this.requestedEnabled = false;
    this.listeners = new Set();
    this.pairingGeneration = 0;
    this.intentGeneration = 0;
    this.releasing = null;
    this.retryTimer = null;
    this.healthTimer = null;
    this.healthAbort = null;
  }

  dependencyPath() { return this.mode === 'ssh' ? this.options.sshPath || 'ssh' : this.options.cloudflaredPath; }

  async initialize() {
    this.dependency = await this.checkDependency(this.dependencyPath());
    return this.snapshot();
  }

  snapshot() {
    const bridgeState = this.bridge?.snapshot();
    if (this.pairing && bridgeState?.pairingExpiresAt !== this.pairing.expiresAt) this.pairing = null;
    return {
      phase: this.phase, mode: this.mode,
      publicUrl: this.publicUrl, pairing: this.pairing,
      devices: bridgeState?.devices || [], error: this.error,
      dependency: this.dependency, connection: this.connection,
      persistent: Boolean(this.options.deviceStore),
      autoStart: Boolean(this.options.autoStart), local: true,
    };
  }

  /** No pairing URL, QR data, private key material or browser credentials. */
  summary() {
    const { pairing, ...summary } = this.snapshot();
    return { ...summary, pairingAvailable: Boolean(pairing) };
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish() { const state = this.snapshot(); for (const listener of this.listeners) listener(state); }
  clearRetry() { if (this.retryTimer !== null) this.cancel(this.retryTimer); this.retryTimer = null; }

  /** Only explicit, persisted startup configuration may restore an enabled entry. */
  async restore() {
    if (!this.options.autoStart || this.disposed || this.options.deviceStore?.readIntent() === false) return this.snapshot();
    return this.enable();
  }

  enable() {
    if (this.disposed) return Promise.reject(new RemoteControlError('DISPOSED', 'The plugin has been unloaded.'));
    this.clearRetry();
    this.options.deviceStore?.writeIntent(true);
    this.requestedEnabled = true;
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
    this.connection = { status: 'reconnecting', checkedAt: Date.now() };
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
      this.dependency = await this.checkDependency(this.dependencyPath());
      if (!this.dependency.available) throw new RemoteControlError(this.mode === 'ssh' ? 'SSH_MISSING' : 'CLOUDFLARED_MISSING', this.mode === 'ssh' ? 'OpenSSH is unavailable. Check the configured SSH executable.' : 'Install cloudflared on this computer, or configure its executable path.');
      if (signal.aborted) throw new RemoteControlError('CANCELLED', 'Remote access startup was cancelled.');
      const bridge = await this.createBridge({
        target: this.options.target, authenticatedUrl: this.options.authenticatedUrl,
        pairingTtlMs: this.options.pairingTtlSeconds * 1000,
        deviceTtlMs: Math.round(this.options.deviceTtlHours * 3600000),
        refreshTtlMs: Math.round(this.options.refreshTtlDays * 86400000),
        refreshAheadMs: this.options.refreshAheadSeconds * 1000,
        refreshRetryMs: this.options.refreshRetrySeconds * 1000,
        maxDevices: this.options.maxDevices, deviceStore: this.options.deviceStore,
        onChange: () => this.publish(),
      });
      this.bridge = bridge;
      if (signal.aborted) throw new RemoteControlError('CANCELLED', 'Remote access startup was cancelled.');
      if (this.mode === 'ssh') {
        bridge.setExternalOrigin(this.options.publicOrigin);
        this.publicUrl = this.options.publicOrigin;
      }
      let tunnelFailure = null;
      const tunnel = await this.startTunnel({
        binary: this.dependencyPath(), origin: bridge.origin,
        protocol: this.options.tunnelProtocol,
        target: this.options.sshTarget, configPath: this.options.sshConfigPath || undefined,
        publicUrl: this.options.publicOrigin, remotePort: this.options.sshRemotePort,
        expectedEntryId: bridge.health?.().entryId,
        timeoutMs: this.options.startupTimeoutSeconds * 1000, signal,
        onHealth: health => {
          if (this.bridge !== bridge || this.disposed || signal.aborted) return;
          this.connection = health;
          this.publish();
        },
        onExit: error => {
          tunnelFailure = error;
          if (this.bridge === bridge && this.phase === 'on') void this.fail(error);
        },
      });
      this.tunnel = tunnel;
      if (tunnelFailure) throw tunnelFailure;
      if (signal.aborted) throw new RemoteControlError('CANCELLED', 'Remote access startup was cancelled.');
      if (this.mode === 'quick') bridge.setExternalOrigin(tunnel.publicUrl);
      this.publicUrl = tunnel.publicUrl;
      this.connection = tunnel.getHealth?.() || { status: bridge.health ? 'checking' : 'online', checkedAt: Date.now() };
      this.phase = 'on';
      await this.issuePair();
      if (!tunnel.getHealth && bridge.health) this.monitorPublicEntry(bridge, tunnel);
      return this.snapshot();
    } catch (error) {
      let failure = error;
      try { await this.release(); } catch (cleanupError) { failure = cleanupError; }
      if (failure.code === 'CLEANUP_FAILED' || (!signal.aborted && !this.disposed)) {
        this.phase = 'error';
        this.error = safeError(failure);
        this.connection = { status: 'offline', checkedAt: Date.now(), error: this.error };
        this.publish();
      }
      if (!signal.aborted && !this.disposed) this.scheduleStartupRetry();
      if (signal.aborted && failure.code !== 'CLEANUP_FAILED') return this.snapshot();
      throw failure;
    }
  }

  monitorPublicEntry(bridge, tunnel) {
    this.healthAbort = new AbortController();
    const signal = this.healthAbort.signal;
    const tick = async () => {
      if (signal.aborted || this.bridge !== bridge || this.tunnel !== tunnel) return;
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        const value = await this.probe(new URL('/__dsh_remote_health', tunnel.publicUrl), { signal: requestSignal, timeoutMs: 5000 });
        if (!value?.ok || value.service !== 'dsh-remote-control' || value.entryId !== bridge.health().entryId) throw new Error('Unexpected entry');
        if (signal.aborted || this.bridge !== bridge) return;
        this.connection = { status: 'online', checkedAt: Date.now() };
      } catch {
        if (signal.aborted || this.bridge !== bridge) return;
        this.connection = { status: 'reconnecting', checkedAt: Date.now(), error: { code: 'ENTRY_UNREACHABLE', message: 'The public entry cannot currently reach this DSH bridge.' } };
      }
      this.publish();
      if (!signal.aborted && this.bridge === bridge) {
        this.healthTimer = this.schedule(tick, 5000);
        this.healthTimer?.unref?.();
      }
    };
    void tick();
  }

  scheduleStartupRetry() {
    if (this.mode !== 'ssh' || !this.options.autoStart || !this.requestedEnabled || this.disposed || this.stopping || this.retryTimer !== null) return;
    this.retryTimer = this.schedule(() => {
      this.retryTimer = null;
      if (!this.requestedEnabled || this.disposed) return;
      void this.enableAt(++this.intentGeneration).catch(() => {});
    }, 15000);
    this.retryTimer?.unref?.();
  }

  /** Explicit user/agent revocation is durable; lifecycle disposal uses close(). */
  disable() {
    ++this.intentGeneration;
    this.requestedEnabled = false;
    this.clearRetry();
    let intentFailure;
    try { this.options.deviceStore?.writeIntent(false); } catch (error) { intentFailure = error; }
    if (this.stopping) {
      if (!intentFailure) return this.stopping;
      return this.stopping.then(() => { this.phase = 'error'; this.error = safeError(intentFailure); this.publish(); throw intentFailure; });
    }
    const startup = this.starting;
    this.abort?.abort();
    this.phase = 'stopping';
    this.pairing = null;
    this.publicUrl = null;
    this.error = null;
    this.connection = { status: 'offline', checkedAt: Date.now() };
    this.publish();
    this.stopping = (async () => {
      await this.release({ preserveDevices: false });
      if (startup) await startup.catch(() => {});
      await this.release({ preserveDevices: false });
      if (!this.bridge) this.options.deviceStore?.clear();
      if (intentFailure) throw intentFailure;
      this.phase = 'off'; this.publish(); return this.snapshot();
    })().catch(error => {
      this.phase = 'error'; this.error = safeError(error); this.publish(); throw error;
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async issuePair() {
    if (this.phase !== 'on' || !this.bridge) throw new RemoteControlError('NOT_RUNNING', 'Enable remote access before pairing a device.');
    const bridge = this.bridge;
    const generation = ++this.pairingGeneration;
    this.pairing = null;
    const pair = bridge.pairing('/');
    const svg = await this.renderQr(pair.url);
    if (generation !== this.pairingGeneration || this.phase !== 'on' || this.bridge !== bridge || bridge.snapshot().pairingExpiresAt !== pair.expiresAt) return this.snapshot();
    this.pairing = { ...pair, qrSvg: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
    this.publish(); return this.snapshot();
  }

  renameDevice(id, value) {
    if (typeof id !== 'string' || !id) throw new RemoteControlError('INVALID_DEVICE', 'Choose a paired device.');
    let label;
    try { label = normalizeDeviceLabel(value); } catch (error) { throw new RemoteControlError('INVALID_REQUEST', error.message); }
    if (!this.bridge?.renameDevice(id, label)) throw new RemoteControlError('DEVICE_NOT_FOUND', 'The device is no longer paired.');
    this.publish(); return this.snapshot();
  }

  revokeDevice(id) {
    if (typeof id !== 'string' || !id) throw new RemoteControlError('INVALID_DEVICE', 'Choose a paired device.');
    if (!this.bridge?.revokeDevice(id)) throw new RemoteControlError('DEVICE_NOT_FOUND', 'The device is no longer paired.');
    this.publish(); return this.snapshot();
  }

  async fail(error) {
    if (this.phase !== 'on') return;
    this.phase = 'error'; this.error = safeError(error); this.pairing = null; this.publicUrl = null;
    this.connection = { status: 'offline', checkedAt: Date.now(), error: this.error };
    try { await this.release(); } catch (cleanupError) { this.error = safeError(cleanupError); }
    this.publish(); this.scheduleStartupRetry();
  }

  async release({ preserveDevices = Boolean(this.options.deviceStore) && this.requestedEnabled } = {}) {
    if (this.healthTimer !== null) this.cancel(this.healthTimer);
    this.healthTimer = null;
    this.healthAbort?.abort(); this.healthAbort = null;
    const bridge = this.bridge, tunnel = this.tunnel;
    this.bridge = null; this.tunnel = null; this.pairing = null; this.publicUrl = null;
    if (!bridge && !tunnel) { if (this.releasing) await this.releasing; return; }
    const previous = this.releasing;
    const cleanup = Promise.allSettled([
      previous,
      Promise.resolve().then(() => bridge?.close({ preserveDevices })),
      Promise.resolve().then(() => tunnel?.stop()),
    ]).then(results => {
      if (results.some(result => result.status === 'rejected')) throw new RemoteControlError('CLEANUP_FAILED', 'A remote-access resource could not be closed. Restart DSH before enabling remote access again.');
    });
    this.releasing = cleanup;
    await cleanup;
    if (this.releasing === cleanup) this.releasing = null;
  }

  /** Preserve opted-in grants and intent when the owning plugin is reloaded. */
  async close() {
    this.disposed = true; ++this.intentGeneration; this.clearRetry(); this.abort?.abort();
    const startup = this.starting;
    this.phase = 'stopping';
    await this.release();
    if (startup) await startup.catch(() => {});
    await this.release();
    this.phase = 'off'; this.listeners.clear();
  }
}

export function safeError(error) {
  return error instanceof RemoteControlError ? { code: error.code, message: error.message }
    : { code: 'REMOTE_CONTROL_FAILED', message: 'The remote-access operation failed. Please retry.' };
}
