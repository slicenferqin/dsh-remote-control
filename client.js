window.__ModuleLoader__.load({
  id: 'dsh-remote-control',
  factory(require) {
    'use strict';
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-remote-control';
    // BEGIN GENERATED CREDENTIAL RENEWER
    // Generated from src/renewal.js; run node build-client.js after changes.
    function createCredentialRenewer({
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
    // END GENERATED CREDENTIAL RENEWER
    // BEGIN GENERATED CONNECTION RECOVERY
    // Generated from src/connection-recovery.js; run node build-client.js after changes.
    function createConnectionCredentialRecovery({
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
    // END GENERATED CONNECTION RECOVERY
    // These flat dictionaries mirror locale/{en,zh}.json's ui section.
    // Kept inside the lazy factory so the Client needs no runtime package imports.
    const DICTIONARIES = {
  "en": {
    "nav": "Remote control",
    "title": "Remote control",
    "intro": "Continue your DSH sessions from your phone.",
    "toggleLabel": "Enable remote control",
    "toggleDescription": "Create a temporary HTTPS connection for your paired devices.",
    "permission": "After scanning and pairing, the device can view and control DSH sessions on this computer.",
    "disableNotice": "Turning off remote control disconnects all remote devices and invalidates the pairing link.",
    "phase.loading": "Loading…",
    "phase.off": "Off",
    "phase.starting": "Starting…",
    "phase.on": "Connected",
    "health.checking": "Checking public entry…",
    "health.reconnecting": "Reconnecting…",
    "health.offline": "Entry unavailable",
    "health.degraded": "Entry check degraded",
    "healthDegradedHint": "The SSH carrier is retained while public checks are retried; a failed probe does not interrupt active sessions.",
    "healthHint": "The entry is enabled but cannot currently reach this computer. Reconnection runs automatically.",
    "persistentHint": "Device grants are saved privately on this computer. A controlled reload preserves pairing; switching Off revokes all devices.",
    "phase.stopping": "Stopping…",
    "phase.error": "Error",
    "busy": "Working…",
    "localOnly": "Manage remote control on this computer.",
    "dependencyMissing": "The configured tunnel program is unavailable. Check OpenSSH or cloudflared using the setup instructions, then retry.",
    "offHint": "Turn on remote control to create a pairing QR code.",
    "startingHint": "Preparing your secure connection. This may take a moment.",
    "stoppingHint": "Disconnecting remote devices…",
    "pairingTitle": "Pair a device",
    "pairingHint": "Scan with your phone’s camera, or open the pairing link on the device you want to connect.",
    "qrAlt": "QR code to pair a device with this computer",
    "qrUnavailable": "The QR code could not be displayed. Use the pairing link or generate a new code.",
    "pairingNone": "Generate a QR code to pair another device.",
    "pairingExpired": "This pairing link has expired. Generate a new QR code to continue.",
    "pairingCountdown": "Expires in {time}",
    "pairingLink": "Pairing link",
    "copyLink": "Copy pairing link",
    "copySuccess": "Pairing link copied.",
    "copyFailed": "Could not copy the link. Select it and copy it manually.",
    "newPairing": "New QR code",
    "generating": "Generating…",
    "publicUrl": "Remote address",
    "devicesTitle": "Paired devices",
    "deviceCount": "{count} devices",
    "devicesEmpty": "No devices paired yet.",
    "deviceUnnamed": "Unnamed device",
    "devicePaired": "Paired {time}",
    "deviceLastSeen": "Last active {time}",
    "timeUnknown": "Unknown",
    "rename": "Rename",
    "renameLabel": "Rename {device}",
    "deviceName": "Device name",
    "deviceNameHint": "Use 1–80 characters.",
    "save": "Save",
    "saving": "Saving…",
    "cancel": "Cancel",
    "revoke": "Revoke",
    "revoking": "Revoking…",
    "revokeLabel": "Revoke access for {device}",
    "revokeHint": "Revoking access disconnects the device. It must scan a new QR code to reconnect.",
    "retry": "Retry",
    "reconnect": "Reconnect",
    "streamDisconnected": "Live updates disconnected. Reconnect to refresh the current status.",
    "requestFailed": "The request failed. Try again.",
    "networkFailed": "Could not reach this computer. Check the connection and retry.",
    "requestTimeout": "The request timed out. Retry to check the current status.",
    "invalidResponse": "The computer returned an invalid response. Retry to refresh the status.",
    "errorDetails": "Details: {message}",
    "errorCode": "Error code: {code}",
    "connectionError": "Remote control could not start. Check the details and retry.",
    "credentialsExpired": "This device has expired or its access was revoked. Pair it again."
  },
  "zh": {
    "nav": "远程控制",
    "title": "远程控制",
    "intro": "在手机上继续使用你的 DSH 会话。",
    "toggleLabel": "开启远程控制",
    "toggleDescription": "为配对设备建立临时 HTTPS 连接。",
    "permission": "扫码配对后，该设备可查看和操作这台电脑的 DSH 会话。",
    "disableNotice": "关闭远程控制会断开所有远程设备，并使配对链接失效。",
    "phase.loading": "正在加载…",
    "phase.off": "已关闭",
    "phase.starting": "正在启动…",
    "phase.on": "已连接",
    "health.checking": "正在确认公网入口…",
    "health.reconnecting": "正在重连…",
    "health.offline": "入口暂不可用",
    "health.degraded": "入口检测暂时异常",
    "healthDegradedHint": "正在重试公网检测，SSH 隧道保持连接；探针抖动不会打断当前会话。",
    "healthHint": "入口已启用，但暂时无法连接这台电脑，系统正在自动重连。",
    "persistentHint": "设备配对已私密保存于本机。正常重载保留配对，主动关闭入口会撤销全部设备。",
    "phase.stopping": "正在关闭…",
    "phase.error": "出错了",
    "busy": "正在处理…",
    "localOnly": "请在电脑端管理远程控制。",
    "dependencyMissing": "当前隧道程序不可用。请按配置检查 OpenSSH 或 cloudflared 后重试。",
    "offHint": "开启远程控制后，即可生成配对二维码。",
    "startingHint": "正在建立安全连接，请稍候。",
    "stoppingHint": "正在断开远程设备…",
    "pairingTitle": "配对设备",
    "pairingHint": "用手机相机扫码，或在要连接的设备上打开配对链接。",
    "qrAlt": "用于与这台电脑配对的二维码",
    "qrUnavailable": "二维码无法显示，请使用配对链接或生成新二维码。",
    "pairingNone": "生成二维码，即可配对新设备。",
    "pairingExpired": "配对链接已过期，请生成新二维码。",
    "pairingCountdown": "{time} 后过期",
    "pairingLink": "配对链接",
    "copyLink": "复制配对链接",
    "copySuccess": "已复制配对链接。",
    "copyFailed": "复制失败，请选中链接后手动复制。",
    "newPairing": "新二维码",
    "generating": "正在生成…",
    "publicUrl": "远程地址",
    "devicesTitle": "已配对设备",
    "deviceCount": "{count} 台设备",
    "devicesEmpty": "还没有已配对设备。",
    "deviceUnnamed": "未命名设备",
    "devicePaired": "配对时间：{time}",
    "deviceLastSeen": "最近活动：{time}",
    "timeUnknown": "未知",
    "rename": "重命名",
    "renameLabel": "重命名「{device}」",
    "deviceName": "设备名称",
    "deviceNameHint": "名称须为 1–80 个字符。",
    "save": "保存",
    "saving": "正在保存…",
    "cancel": "取消",
    "revoke": "撤销",
    "revoking": "正在撤销…",
    "revokeLabel": "撤销「{device}」的访问权限",
    "revokeHint": "撤销后会断开该设备，重新连接需要扫描新的二维码。",
    "retry": "重试",
    "reconnect": "重新连接",
    "streamDisconnected": "实时更新已断开，重新连接可刷新当前状态。",
    "requestFailed": "操作失败，请重试。",
    "networkFailed": "无法连接到这台电脑，请检查连接后重试。",
    "requestTimeout": "请求超时，请重试以确认当前状态。",
    "invalidResponse": "电脑端返回了无效数据，请重试刷新状态。",
    "errorDetails": "详细信息：{message}",
    "errorCode": "错误代码：{code}",
    "connectionError": "远程控制启动失败，请查看详细信息后重试。",
    "credentialsExpired": "设备已过期或被撤销，请重新配对。"
  }
};
    const CSS = `
.dsh-rc { display:flex; flex-direction:column; gap:14px; max-width:760px; min-width:0; color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.5; }
.dsh-rc * { box-sizing:border-box; }
.dsh-rc h2,.dsh-rc h3,.dsh-rc p { margin:0; }
.dsh-rc h2 { font-size:18px; font-weight:600; }
.dsh-rc h3 { font-size:14px; font-weight:600; }
.dsh-rc .dsh-rc-muted { color:var(--dsw-alias-label-tertiary); }
.dsh-rc .dsh-rc-card { border:0.5px solid var(--dsw-alias-border-l2); border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:12px; background:var(--dsw-alias-bg-layer-1); min-width:0; }
.dsh-rc .dsh-rc-row { display:flex; align-items:center; justify-content:space-between; gap:14px; min-width:0; }
.dsh-rc .dsh-rc-copy { min-width:0; display:flex; flex-direction:column; gap:3px; }
.dsh-rc .dsh-rc-toggle-label { font-weight:500; }
.dsh-rc .dsh-rc-status { display:inline-flex; align-items:center; gap:6px; flex:0 0 auto; font-size:12px; color:var(--dsw-alias-label-tertiary); }
.dsh-rc .dsh-rc-status::before { content:''; width:6px; height:6px; border-radius:50%; background:currentColor; }
.dsh-rc .dsh-rc-status[data-phase='on'] { color:var(--dsw-alias-state-success-primary); }
.dsh-rc .dsh-rc-status[data-phase='starting'],.dsh-rc .dsh-rc-status[data-phase='stopping'] { color:var(--dsw-alias-state-warn-primary); }
.dsh-rc .dsh-rc-status[data-phase='error'],.dsh-rc .dsh-rc-error { color:var(--dsw-alias-state-error-primary); }
.dsh-rc .dsh-rc-note { border-radius:8px; padding:10px 12px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.dsh-rc .dsh-rc-note p + p { margin-top:5px; }
.dsh-rc .dsh-rc-error-details { font-size:12px; overflow-wrap:anywhere; white-space:pre-wrap; }
.dsh-rc .dsh-rc-button { appearance:none; display:inline-flex; align-items:center; justify-content:center; gap:4px; min-height:32px; padding:5px 12px; border:0.5px solid var(--dsw-alias-border-l3); border-radius:8px; background:transparent; color:var(--dsw-alias-label-primary); font:inherit; line-height:20px; cursor:pointer; flex:0 0 auto; }
.dsh-rc .dsh-rc-button:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.dsh-rc .dsh-rc-button:disabled { opacity:0.4; cursor:default; }
.dsh-rc .dsh-rc-button-primary { background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-primary-foreground); border-color:transparent; }
.dsh-rc .dsh-rc-button-primary:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover); }
.dsh-rc .dsh-rc-button-danger { color:var(--dsw-alias-state-error-primary); }
.dsh-rc button:focus-visible,.dsh-rc input:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }
.dsh-rc .dsh-rc-switch { appearance:none; box-sizing:border-box; position:relative; flex:0 0 auto; width:36px; height:20px; padding:2px; border:0; border-radius:999px; corner-shape:round; background:var(--dsw-alias-border-l3); cursor:pointer; }
.dsh-rc .dsh-rc-switch[aria-checked='true'] { background:var(--dsw-alias-brand-primary); }
.dsh-rc .dsh-rc-switch:disabled { opacity:0.5; cursor:default; }
.dsh-rc .dsh-rc-switch-thumb { display:block; width:16px; height:16px; border-radius:50%; corner-shape:round; background:var(--dsw-alias-switch-thumb); transition:transform 120ms ease; }
.dsh-rc .dsh-rc-switch[aria-checked='true'] .dsh-rc-switch-thumb { transform:translateX(16px); background:var(--dsw-alias-label-primary-foreground); }
.dsh-rc .dsh-rc-pairing { display:flex; gap:20px; align-items:flex-start; min-width:0; }
/* QR black and white are artwork colors, independent of the UI palette. */
.dsh-rc .dsh-rc-qr { display:block; width:184px; height:184px; max-width:100%; background:#fff; border-radius:8px; object-fit:contain; flex:0 0 auto; }
.dsh-rc .dsh-rc-pairing-detail { flex:1; min-width:0; display:flex; flex-direction:column; gap:10px; }
.dsh-rc .dsh-rc-countdown { font-size:12px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dsh-rc .dsh-rc-field { display:flex; flex-direction:column; gap:5px; min-width:0; }
.dsh-rc .dsh-rc-input { width:100%; min-width:0; min-height:32px; padding:5px 8px; border:0.5px solid var(--dsw-alias-border-l4); border-radius:8px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; line-height:20px; }
.dsh-rc .dsh-rc-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.dsh-rc .dsh-rc-devices { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; }
.dsh-rc .dsh-rc-device { padding:12px 0; border-top:0.5px solid var(--dsw-alias-border-l1); }
.dsh-rc .dsh-rc-device:first-child { padding-top:0; border-top:0; }
.dsh-rc .dsh-rc-device:last-child { padding-bottom:0; }
.dsh-rc .dsh-rc-device-name { overflow-wrap:anywhere; font-weight:500; }
.dsh-rc .dsh-rc-device-times { font-size:12px; color:var(--dsw-alias-label-tertiary); }
.dsh-rc .dsh-rc-device > .dsh-rc-copy { flex:1; }
.dsh-rc .dsh-rc-device .dsh-rc-button,.dsh-rc .dsh-rc-device .dsh-rc-input { min-height:40px; }
.dsh-rc .dsh-rc-rename { display:flex; flex-direction:column; gap:8px; min-width:0; }
.dsh-rc .dsh-rc-rename-hint { font-size:12px; color:var(--dsw-alias-label-tertiary); }
.dsh-rc .dsh-rc-feedback { font-size:12px; min-height:18px; }
@media (max-width:600px) { .dsh-rc .dsh-rc-pairing { flex-direction:column; align-items:stretch; } .dsh-rc .dsh-rc-qr { align-self:center; } .dsh-rc .dsh-rc-card { padding:13px; } .dsh-rc .dsh-rc-device { flex-direction:column; align-items:stretch; gap:10px; } .dsh-rc .dsh-rc-device > .dsh-rc-actions { justify-content:flex-end; } }
@media (prefers-reduced-motion:reduce) { .dsh-rc .dsh-rc-switch-thumb { transition:none; } }
`;

    const OFF = Object.freeze({ phase: 'off', publicUrl: null, pairing: null, devices: [], error: null, dependency: { available: false }, local: false });
    const PHASES = new Set(['off', 'starting', 'on', 'stopping', 'error']);
    function failure(code, message) {
      return Object.assign(new Error(message || code), { code });
    }
    function parseSnapshot(value) {
      if (!value || !PHASES.has(value.phase) || !Array.isArray(value.devices)
        || typeof value.local !== 'boolean' || typeof value.dependency?.available !== 'boolean'
        || (value.publicUrl !== null && typeof value.publicUrl !== 'string')
        || (value.pairing !== null && (!value.pairing || typeof value.pairing.url !== 'string' || typeof value.pairing.qrSvg !== 'string'))
        || value.devices.some(device => !device || typeof device.id !== 'string' || typeof device.label !== 'string')) {
        throw failure('invalid_response');
      }
      return value;
    }
    function timestamp(value) {
      if (value === null || value === undefined || value === '') return NaN;
      return typeof value === 'number' ? value : Date.parse(value);
    }
    function formatTime(value, locale, t) {
      const time = timestamp(value);
      if (!Number.isFinite(time)) return t('timeUnknown');
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time);
    }
    function countdown(milliseconds) {
      const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    function qrDataUrl(value) {
      // Host SVG is rendered in an image document, never inserted into the DOM.
      return typeof value === 'string' && /^data:image\/svg\+xml(?:;[^,]*)?,/i.test(value) ? value : null;
    }
    function errorText(error, t) {
      const keys = { invalid_response: 'invalidResponse', network_error: 'networkFailed', request_timeout: 'requestTimeout' };
      return t(keys[error?.code] || 'requestFailed');
    }

    function useController() {
      const [view, setView] = React.useState({ snapshot: OFF, loaded: false, busy: null, restricted: false, requestError: null, disconnected: false });
      const commands = React.useRef(null);
      React.useEffect(() => {
        let alive = true;
        let locked = false;
        let restricted = false;
        let source = null;
        const requests = new Set();
        const patch = update => { if (alive) setView(previous => ({ ...previous, ...update })); };
        const closeStream = () => {
          if (source) { source.onmessage = null; source.onerror = null; source.close(); }
          source = null;
        };
        const restrict = () => {
          restricted = true;
          closeStream();
          patch({ restricted: true, loaded: true, snapshot: OFF, requestError: null, disconnected: false });
        };
        const adopt = snapshot => {
          if (!snapshot.local) { restrict(); return; }
          patch({ snapshot, loaded: true });
        };
        async function request(action, deviceId, label) {
          const controller = new AbortController();
          requests.add(controller);
          let timedOut = false;
          const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, action === 'enable' ? 210000 : 15000);
          try {
            const response = await fetch(action ? 'api/dsh-remote-control/control' : 'api/dsh-remote-control/status', {
              method: action ? 'POST' : 'GET',
              credentials: 'same-origin',
              cache: 'no-store',
              signal: controller.signal,
              headers: action ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
              ...(action ? { body: JSON.stringify({ action, ...(deviceId === undefined ? {} : { deviceId }), ...(label === undefined ? {} : { label }) }) } : {}),
            });
            if (response.status === 403) { restrict(); throw failure('local_only'); }
            let payload;
            try { payload = await response.json(); } catch (error) {
              // A proxy or disconnected Host may return a non-JSON response.
              throw failure('invalid_response');
            }
            if (!response.ok) throw failure(payload?.error?.code || `http_${response.status}`, payload?.error?.message);
            return parseSnapshot(payload);
          } catch (error) {
            if (timedOut) throw failure('request_timeout');
            if (error?.name === 'AbortError') throw error;
            if (error?.code) throw error;
            throw failure('network_error');
          } finally {
            clearTimeout(timeout);
            requests.delete(controller);
          }
        }
        function report(error, retry) {
          if (!alive || error?.name === 'AbortError' || restricted) return;
          patch({ loaded: true, requestError: { code: error.code || 'network_error', message: error.message || '', retry } });
        }
        function openStream() {
          closeStream();
          if (!alive || restricted) return;
          if (typeof EventSource === 'undefined') { patch({ disconnected: true }); return; }
          source = new EventSource('api/dsh-remote-control/events');
          source.onmessage = event => {
            try { adopt(parseSnapshot(JSON.parse(event.data))); } catch (error) {
              closeStream();
              patch({ disconnected: true });
              report(error?.code ? error : failure('invalid_response'));
            }
          };
          source.onerror = () => {
            if (!alive || restricted) return;
            // Close native retries; one status read can identify a remote 403.
            // Further reconnects require an explicit click, never a polling loop.
            closeStream();
            patch({ disconnected: true });
            void request().then(snapshot => { if (alive) adopt(snapshot); }).catch(report);
          };
        }
        async function refresh() {
          if (locked || restricted || !alive) return;
          locked = true;
          closeStream();
          patch({ busy: 'refresh', requestError: null });
          try {
            const snapshot = await request();
            if (!alive) return;
            adopt(snapshot);
            if (snapshot.local && !restricted) { patch({ disconnected: false }); openStream(); }
          } catch (error) { report(error); } finally {
            locked = false;
            patch({ busy: null });
          }
        }
        async function control(action, deviceId, label) {
          if (locked || restricted || !alive) return false;
          locked = true;
          patch({ busy: deviceId === undefined ? action : `${action}:${deviceId}`, requestError: null });
          try {
            const snapshot = await request(action, deviceId, label);
            if (!alive || restricted) return false;
            adopt(snapshot);
            return snapshot.local;
          } catch (error) {
            report(error, { action, deviceId, ...(label === undefined ? {} : { label }) });
            return false;
          } finally {
            locked = false;
            patch({ busy: null });
          }
        }
        commands.current = { refresh, control, clearError: () => patch({ requestError: null }) };
        void refresh();
        return () => {
          alive = false;
          commands.current = null;
          closeStream();
          for (const controller of requests) controller.abort();
          requests.clear();
        };
      }, []);
      return { ...view, refresh: () => commands.current?.refresh(), control: (action, deviceId, label) => commands.current?.control(action, deviceId, label), clearError: () => commands.current?.clearError() };
    }

    function RemoteControlSection({ t, language }) {
      const state = useController();
      const { snapshot, loaded, busy, restricted, requestError, disconnected, control, refresh, clearError } = state;
      const [rename, setRename] = React.useState(null);
      const [now, setNow] = React.useState(Date.now);
      const [copyStatus, setCopyStatus] = React.useState(null);
      const [copyBusy, setCopyBusy] = React.useState(false);
      const copyLock = React.useRef(false);
      const [brokenQr, setBrokenQr] = React.useState(null);
      const input = React.useRef(null);
      const fieldId = React.useId();
      const alive = React.useRef(true);
      React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
      const pairing = snapshot.phase === 'on' && !restricted ? snapshot.pairing : null;
      const expires = timestamp(pairing?.expiresAt);
      const remaining = expires - now;
      const expired = !Number.isFinite(expires) || remaining <= 0;
      React.useEffect(() => {
        setCopyStatus(null);
        setNow(Date.now());
        if (!Number.isFinite(expires) || expires <= Date.now()) return undefined;
        const tick = setInterval(() => {
          const time = Date.now();
          setNow(time);
          if (time >= expires) clearInterval(tick);
        }, 1000);
        return () => clearInterval(tick);
      }, [pairing?.url, expires]);
      React.useEffect(() => {
        if (!copyStatus) return undefined;
        const timeout = setTimeout(() => setCopyStatus(null), 5000);
        return () => clearTimeout(timeout);
      }, [copyStatus]);
      async function copyPairing() {
        if (!pairing || expired || copyLock.current) return;
        copyLock.current = true;
        setCopyBusy(true);
        setCopyStatus(null);
        try {
          if (!navigator.clipboard?.writeText) throw failure('clipboard_unavailable');
          await navigator.clipboard.writeText(pairing.url);
          if (alive.current) setCopyStatus('copySuccess');
        } catch (error) {
          // Browser permissions can reject clipboard writes; keep manual copying available.
          if (alive.current) {
            input.current?.focus();
            input.current?.select();
            setCopyStatus('copyFailed');
          }
        } finally {
          copyLock.current = false;
          if (alive.current) setCopyBusy(false);
        }
      }
      const phase = loaded ? (requestError && !snapshot.local ? 'error' : snapshot.phase) : 'loading';
      const health = snapshot.connection?.status;
      const healthPending = phase === 'on' && health && health !== 'online';
      const phaseLabel = healthPending ? t(`health.${['checking', 'reconnecting', 'degraded'].includes(health) ? health : 'offline'}`) : t(`phase.${phase}`);
      const transitioning = snapshot.phase === 'starting' || snapshot.phase === 'stopping';
      const checked = snapshot.phase === 'on' || transitioning;
      const disabled = Boolean(busy) || !loaded || !snapshot.local || restricted || transitioning;
      function beginRename(device) {
        if (disabled) return;
        if (requestError?.retry?.action === 'rename') clearError();
        setRename({ deviceId: device.id, label: device.label });
      }
      function cancelRename() {
        if (disabled) return;
        if (requestError?.retry?.action === 'rename') clearError();
        setRename(null);
      }
      async function saveRename(deviceId = rename?.deviceId, label = rename?.label) {
        const trimmed = label?.trim() || '';
        if (disabled || !deviceId || trimmed.length < 1 || trimmed.length > 80) return;
        const success = await control('rename', deviceId, trimmed);
        if (success && alive.current) setRename(current => current?.deviceId === deviceId ? null : current);
      }
      function retryRequest() {
        const retry = requestError?.retry;
        if (retry?.action === 'rename') return saveRename(retry.deviceId, retry.label);
        return retry ? control(retry.action, retry.deviceId, retry.label) : hostError && snapshot.dependency.available ? control('enable') : refresh();
      }
      const qr = pairing && !expired ? qrDataUrl(pairing.qrSvg) : null;
      const hostError = snapshot.phase === 'error' ? snapshot.error : null;
      const displayError = requestError || hostError;
      const timeLocale = language || undefined;
      const button = (key, onClick, extra = {}) => h('button', { type: 'button', className: 'dsh-rc-button', disabled, onClick, ...extra }, t(key));
      const errorBlock = displayError && !restricted ? h('div', { className: 'dsh-rc-note', role: 'alert' },
        h('p', { className: 'dsh-rc-error' }, requestError ? errorText(requestError, t) : t('connectionError')),
        displayError.message && displayError.message !== displayError.code ? h('p', { className: 'dsh-rc-error-details' }, t('errorDetails', { message: displayError.message })) : null,
        displayError.code ? h('p', { className: 'dsh-rc-muted dsh-rc-error-details' }, t('errorCode', { code: displayError.code })) : null,
        h('div', { className: 'dsh-rc-actions' }, button('retry', retryRequest, { disabled: Boolean(busy) }))) : null;
      return h('section', { className: 'dsh-rc', 'aria-labelledby': `${fieldId}-title`, 'aria-busy': !loaded },
        h('style', null, CSS),
        h('div', { className: 'dsh-rc-copy' }, h('h2', { id: `${fieldId}-title` }, t('title')), h('p', { className: 'dsh-rc-muted' }, t('intro'))),
        h('div', { className: 'dsh-rc-card' },
          h('div', { className: 'dsh-rc-row' },
            h('div', { className: 'dsh-rc-copy' }, h('p', { className: 'dsh-rc-toggle-label', id: `${fieldId}-toggle` }, t('toggleLabel')), h('p', { className: 'dsh-rc-muted', id: `${fieldId}-description` }, t('toggleDescription'))),
            h('button', { type: 'button', role: 'switch', className: 'dsh-rc-switch', 'aria-checked': checked, 'aria-busy': Boolean(busy) || transitioning, 'aria-labelledby': `${fieldId}-toggle`, 'aria-describedby': `${fieldId}-description ${fieldId}-permission ${fieldId}-disable`, disabled: disabled || (!checked && !snapshot.dependency.available), onClick: () => control(checked ? 'disable' : 'enable') }, h('span', { className: 'dsh-rc-switch-thumb' }))),
          h('span', { className: 'dsh-rc-status', 'data-phase': healthPending ? 'starting' : phase, role: 'status' }, phaseLabel),
          h('div', { className: 'dsh-rc-note' }, h('p', { id: `${fieldId}-permission` }, t('permission')), h('p', { className: 'dsh-rc-muted', id: `${fieldId}-disable` }, t('disableNotice'))),
          restricted ? h('p', { role: 'status' }, t('localOnly')) : null,
          loaded && snapshot.local && !restricted && !snapshot.dependency.available ? h('div', { className: 'dsh-rc-copy' }, h('p', { className: 'dsh-rc-muted' }, t('dependencyMissing')), h('div', { className: 'dsh-rc-actions' }, button('retry', refresh))) : null,
          loaded && snapshot.local && !restricted && !displayError && snapshot.phase !== 'on' ? h('p', { className: 'dsh-rc-muted' }, t(snapshot.phase === 'starting' ? 'startingHint' : snapshot.phase === 'stopping' ? 'stoppingHint' : 'offHint')) : null),
        errorBlock,
        healthPending && !restricted ? h('div', { className: 'dsh-rc-note', role: 'status' }, t(health === 'degraded' ? 'healthDegradedHint' : 'healthHint')) : null,
        snapshot.persistent && !restricted ? h('p', { className: 'dsh-rc-muted' }, t('persistentHint')) : null,
        disconnected && !restricted ? h('div', { className: 'dsh-rc-note dsh-rc-copy', role: 'status' }, h('p', null, t('streamDisconnected')), h('div', { className: 'dsh-rc-actions' }, button('reconnect', refresh, { disabled: Boolean(busy) }))) : null,
        snapshot.phase === 'on' && !restricted ? h('div', { className: 'dsh-rc-card' },
          h('div', { className: 'dsh-rc-row' }, h('h3', null, t('pairingTitle')), button(busy === 'pair' ? 'generating' : 'newPairing', () => control('pair'))),
          h('p', { className: 'dsh-rc-muted' }, t('pairingHint')),
          pairing && !expired ? h('div', { className: 'dsh-rc-pairing' },
            qr && brokenQr !== qr ? h('img', { className: 'dsh-rc-qr', src: qr, alt: t('qrAlt'), width: 184, height: 184, onError: () => setBrokenQr(qr) }) : h('p', { className: 'dsh-rc-muted' }, t('qrUnavailable')),
            h('div', { className: 'dsh-rc-pairing-detail' },
              h('p', { className: 'dsh-rc-countdown', role: 'timer', 'aria-live': 'off' }, t('pairingCountdown', { time: countdown(remaining) })),
              h('label', { className: 'dsh-rc-field', htmlFor: `${fieldId}-link` }, h('span', null, t('pairingLink')), h('input', { className: 'dsh-rc-input', id: `${fieldId}-link`, ref: input, readOnly: true, value: pairing.url, onFocus: event => event.currentTarget.select(), autoComplete: 'off', spellCheck: false })),
              h('div', { className: 'dsh-rc-actions' }, button('copyLink', copyPairing, { disabled: Boolean(busy) || copyBusy, className: 'dsh-rc-button dsh-rc-button-primary' })),
              h('p', { className: `dsh-rc-feedback${copyStatus === 'copyFailed' ? ' dsh-rc-error' : ' dsh-rc-muted'}`, role: 'status' }, copyStatus ? t(copyStatus) : null)))
            : h('p', { className: 'dsh-rc-muted', role: 'status' }, t(pairing ? 'pairingExpired' : 'pairingNone')),
          snapshot.publicUrl ? h('label', { className: 'dsh-rc-field' }, h('span', { className: 'dsh-rc-muted' }, t('publicUrl')), h('input', { className: 'dsh-rc-input', readOnly: true, value: snapshot.publicUrl, autoComplete: 'off', spellCheck: false, onFocus: event => event.currentTarget.select() })) : null) : null,
        loaded && snapshot.local && !restricted ? h('div', { className: 'dsh-rc-card' },
          h('div', { className: 'dsh-rc-row' }, h('h3', null, t('devicesTitle')), h('span', { className: 'dsh-rc-muted' }, t('deviceCount', { count: snapshot.devices.length }))),
          snapshot.devices.length ? h('ul', { className: 'dsh-rc-devices' }, snapshot.devices.map(device => {
            const label = device.label || t('deviceUnnamed');
            const editing = rename?.deviceId === device.id;
            const trimmed = editing ? rename.label.trim() : '';
            return h('li', { className: 'dsh-rc-device dsh-rc-row', key: device.id },
              h('div', { className: 'dsh-rc-copy' },
                editing ? h('div', { className: 'dsh-rc-rename', 'aria-busy': busy === `rename:${device.id}` },
                  h('label', { className: 'dsh-rc-field', htmlFor: `${fieldId}-device-name` },
                    h('span', null, t('deviceName')),
                    h('input', { className: 'dsh-rc-input', id: `${fieldId}-device-name`, value: rename.label, maxLength: 80, autoFocus: true, autoComplete: 'off', disabled, 'aria-describedby': `${fieldId}-device-name-hint`, onFocus: event => event.currentTarget.select(), onChange: event => setRename({ deviceId: device.id, label: event.currentTarget.value }), onKeyDown: event => {
                      if (event.nativeEvent?.isComposing || event.isComposing) return;
                      if (event.key === 'Enter') { event.preventDefault(); void saveRename(); }
                      if (event.key === 'Escape') { event.preventDefault(); cancelRename(); }
                    } })),
                  h('p', { className: 'dsh-rc-rename-hint', id: `${fieldId}-device-name-hint` }, t('deviceNameHint')),
                  h('div', { className: 'dsh-rc-actions' },
                    button(busy === `rename:${device.id}` ? 'saving' : 'save', () => saveRename(), { className: 'dsh-rc-button dsh-rc-button-primary', disabled: disabled || trimmed.length < 1 || trimmed.length > 80 }),
                    button('cancel', cancelRename)))
                  : h('p', { className: 'dsh-rc-device-name' }, label),
                h('p', { className: 'dsh-rc-device-times' }, t('devicePaired', { time: formatTime(device.pairedAt, timeLocale, t) })),
                h('p', { className: 'dsh-rc-device-times' }, t('deviceLastSeen', { time: formatTime(device.lastSeenAt, timeLocale, t) }))),
              h('div', { className: 'dsh-rc-actions' },
                !editing ? button('rename', () => beginRename(device), { 'aria-label': t('renameLabel', { device: label }) }) : null,
                button(busy === `revoke:${device.id}` ? 'revoking' : 'revoke', () => control('revoke', device.id), { className: 'dsh-rc-button dsh-rc-button-danger', 'aria-label': t('revokeLabel', { device: label }) })));
          })) : h('p', { className: 'dsh-rc-muted' }, t('devicesEmpty')),
          snapshot.devices.length ? h('p', { className: 'dsh-rc-muted' }, t('revokeHint')) : null) : null);
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-remote-control: dictionaries');
        const t = ctx.locale.bind(NS);
        function LocalizedSection(props) {
          const locale = React.useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot());
          return h(RemoteControlSection, { ...props, language: locale.active });
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dsh-remote-control', order: 35,
          label: () => t('nav'), locale: NS,
        }, LocalizedSection));
        const location = window.location;
        if (location.protocol === 'https:' && !location.port
          && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
          let credentialState = { phase: 'idle' };
          const listeners = new Set();
          const snapshot = () => credentialState;
          const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
          function CredentialNotice() {
            const state = React.useSyncExternalStore(subscribe, snapshot, snapshot);
            React.useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot());
            if (state.phase !== 'expired') return null;
            return h('div', {
              role: 'alert',
              style: {
                position: 'fixed', insetInline: '12px', top: 'max(12px, env(safe-area-inset-top))',
                zIndex: 1000, pointerEvents: 'none',
                marginInline: 'auto', maxWidth: '520px', boxSizing: 'border-box', padding: '12px 16px',
                border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: '12px',
                background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-state-error-primary)',
                fontSize: '13px', lineHeight: 1.5, overflowWrap: 'anywhere',
              },
            }, t('credentialsExpired'));
          }
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay', id: 'dsh-remote-control.credentials', order: 100, locale: NS,
          }, CredentialNotice));
          ctx.effect(() => {
            let recovery;
            const renewer = createCredentialRenewer({
              fetch: (...args) => window.fetch(...args), window, document,
              onState(next) { credentialState = next; recovery?.notifyCredentialState(next); for (const listener of listeners) listener(); },
            });
            const probe = new AbortController();
            const timeout = setTimeout(() => probe.abort(), 10000);
            void window.fetch('/__dsh_remote_health', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: probe.signal })
              .then(async response => {
                if (!response.ok) return;
                const marker = await response.json();
                if (!probe.signal.aborted && marker?.ok === true && marker.service === 'dsh-remote-control') {
                  clearTimeout(timeout);
                  await renewer.start();
                  if (!probe.signal.aborted) {
                    recovery = createConnectionCredentialRecovery({ connection: ctx.connection, refresh: () => renewer.refresh() });
                    recovery.start();
                  }
                }
              }).catch(() => {}).finally(() => clearTimeout(timeout));
            return () => { probe.abort(); clearTimeout(timeout); recovery?.dispose(); renewer.dispose(); };
          }, 'dsh-remote-control: browser credential renewal');
        }
      },
    };
  },
});
