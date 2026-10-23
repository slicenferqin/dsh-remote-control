import Schema from '@deepseek-ai/schemastery';
import { RemoteControl, safeError } from './src/controller.js';
import { RemoteControlError } from './src/tunnel.js';
import { createDeviceStore, normalizeRemoteOrigin } from './src/device-store.js';

export const name = 'dsh-remote-control';
export const inject = ['webServer', 'connection', 'tools'];
export const Config = Schema.object({
  tunnelMode: Schema.union(['quick', 'ssh']).default('quick').description('Temporary Cloudflare entry or a fixed HTTPS entry carried by a restricted SSH reverse tunnel.'),
  publicOrigin: Schema.string().default('').description('Fixed HTTPS origin for SSH mode, for example https://dsh.example.com.'),
  sshPath: Schema.string().default('ssh'),
  sshTarget: Schema.string().default('').description('SSH alias configured for the restricted relay account.'),
  sshConfigPath: Schema.string().default('').description('Optional absolute OpenSSH configuration file; private keys remain in local files.'),
  sshRemotePort: Schema.number().min(1024).max(65535).step(1).default(18380).description('Remote loopback-only port used by the server HTTPS proxy.'),
  persistDevices: Schema.boolean().default(false).description('Persist device refresh grants across controlled plugin restarts.'),
  deviceStorePath: Schema.string().default('').description('Absolute path to a private device-state file; required when persistDevices is enabled.'),
  autoStart: Schema.boolean().default(false).description('Restore a previously enabled entry on startup; an explicit Off remains off.'),
  cloudflaredPath: Schema.string().default('cloudflared').description('cloudflared executable name or absolute path on this computer.'),
  tunnelProtocol: Schema.union(['http2', 'quic', 'auto']).default('http2').description('Transport from cloudflared to Cloudflare; HTTP/2 avoids depending on outbound UDP.'),
  startupTimeoutSeconds: Schema.number().min(10).max(180).step(1).default(60),
  pairingTtlSeconds: Schema.number().min(30).max(600).step(1).default(120),
  deviceTtlHours: Schema.number().min(1).max(168).default(8).description('Access credential lifetime in hours; browsers renew it automatically while a refresh credential remains valid.'),
  refreshTtlDays: Schema.number().min(1).max(90).default(10).description('Rolling refresh credential lifetime in days, counted again after each successful refresh.'),
  refreshAheadSeconds: Schema.number().min(30).max(3600).step(1).default(300).description('Renew access credentials this many seconds before expiry.'),
  refreshRetrySeconds: Schema.number().min(5).max(60).step(1).default(30).description('Retry delay after a temporary refresh transport failure.'),
  maxDevices: Schema.number().min(1).max(16).step(1).default(4),
  heartbeatSeconds: Schema.number().min(5).max(60).step(1).default(15),
}).description('Browser remote control with temporary or fixed HTTPS entry. Starts off unless automatic restoration is explicitly configured.');

/** Register the authenticated local control surface and an agent capability that cannot grant access. */
export async function apply(ctx, config) {
  if (config.refreshTtlDays * 24 <= config.deviceTtlHours) {
    throw new Error('dsh-remote-control: refreshTtlDays must be longer than deviceTtlHours / 24.');
  }
  if (config.refreshAheadSeconds >= config.deviceTtlHours * 3600) {
    throw new Error('dsh-remote-control: refreshAheadSeconds must be shorter than deviceTtlHours * 3600.');
  }
  if (config.tunnelMode === 'ssh') {
    config = { ...config, publicOrigin: normalizeRemoteOrigin(config.publicOrigin) };
    if (!config.sshTarget) throw new Error('dsh-remote-control: SSH mode requires an SSH target.');
  }
  if (config.persistDevices && !config.deviceStorePath) throw new Error('dsh-remote-control: choose an absolute deviceStorePath for persistent pairing.');
  const deviceStore = config.persistDevices ? createDeviceStore(config.deviceStorePath) : undefined;
  const control = new RemoteControl({
    ...config, deviceStore,
    target: ctx.webServer.getOrigin(),
    authenticatedUrl: baseUrl => ctx.connection.authenticatedUrl(baseUrl),
  });
  ctx.effect(() => () => control.close());
  await control.initialize();
  const streams = new Set();
  ctx.effect(() => () => {
    for (const response of streams) response.end();
    streams.clear();
  });
  const base = '/api/dsh-remote-control';
  const register = (suffix, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${base}/${suffix}`,
    handler: async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      const rejection = ctx.connection.requestRejection(request);
      if (rejection) return sendJson(response, rejection, { error: { code: 'AUTH_REQUIRED', message: 'Use an authenticated DSH browser.' } });
      if (!isLocalRequest(request)) return sendJson(response, 403, { error: { code: 'LOCAL_ONLY', message: 'Manage remote access from this computer.' } });
      try {
        await handler(request, response);
      } catch (error) {
        if (!response.headersSent) sendJson(response, error.code === 'DEVICE_NOT_FOUND' ? 404 : ['INVALID_REQUEST', 'INVALID_DEVICE'].includes(error.code) ? 400 : 503, { error: safeError(error) });
        else response.end();
      }
    },
  }));

  register('status', (request, response) => {
    if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
    sendJson(response, 200, control.snapshot());
  });
  register('control', async (request, response) => {
    if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
    // Browser mutation must originate from the local page, even if a signed cookie is present.
    const expected = new URL(ctx.webServer.getOrigin());
    const incomingHost = request.headers.host;
    if (!incomingHost || request.headers.origin !== `${expected.protocol}//${incomingHost}`) {
      return sendJson(response, 403, { error: { code: 'LOCAL_ONLY', message: 'Use the local DSH settings page.' } });
    }
    const body = await readJson(request);
    validateAction(body, false);
    switch (body.action) {
      case 'enable': await control.enable(); break;
      case 'disable': await control.disable(); break;
      case 'pair': await control.issuePair(); break;
      case 'rename': control.renameDevice(body.deviceId, body.label); break;
      case 'revoke': control.revokeDevice(body.deviceId); break;
      default: throw new RemoteControlError('INVALID_REQUEST', 'Unsupported remote-control action.');
    }
    sendJson(response, 200, control.snapshot());
  });
  register('events', (request, response) => {
    if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
    streams.add(response);
    const publish = state => {
      if (!response.destroyed && !response.writableEnded) response.write(`data: ${JSON.stringify(state)}\n\n`);
    };
    const unsubscribe = control.subscribe(publish);
    publish(control.snapshot());
    response.once('close', () => { unsubscribe(); streams.delete(response); });
  });
  ctx.effect(() => {
    const heartbeat = setInterval(() => {
      for (const response of streams) if (!response.destroyed) response.write(': keepalive\n\n');
    }, config.heartbeatSeconds * 1000);
    heartbeat.unref?.();
    return () => clearInterval(heartbeat);
  });
  ctx.effect(() => ctx.tools.register({
    name: 'remote_control',
    description: 'Read entry reachability and paired devices, rename or revoke a device, or disconnect all devices. Enabling and pairing stay in local Settings; results exclude credentials.',
    parameters: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: { action: { type: 'string', enum: ['status', 'disable'], description: 'Read status or disconnect all remote devices.' } },
          required: ['action'], additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            action: { const: 'revoke' },
            deviceId: { type: 'string', minLength: 1, description: 'Paired device id returned by status.' },
          },
          required: ['action', 'deviceId'], additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            action: { const: 'rename' },
            deviceId: { type: 'string', minLength: 1, description: 'Paired device id returned by status.' },
            label: { type: 'string', minLength: 1, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]*[^\\s\\u0000-\\u001f\\u007f-\\u009f][^\\u0000-\\u001f\\u007f-\\u009f]*$', description: 'Device name: 1–80 characters after trimming; no control characters.' },
          },
          required: ['action', 'deviceId', 'label'], additionalProperties: false,
        },
      ],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: args => args?.action === 'status',
    execute: async args => {
      validateAction(args, true);
      if (args.action === 'disable') await control.disable();
      else if (args.action === 'rename') control.renameDevice(args.deviceId, args.label);
      else if (args.action === 'revoke') control.revokeDevice(args.deviceId);
      return control.summary();
    },
  }));
  if (config.autoStart) {
    queueMicrotask(() => {
      if (control.disposed) return;
      void control.restore().catch(error => {
        if (!control.disposed && control.phase === 'off') {
          control.phase = 'error'; control.error = safeError(error); control.publish();
        }
      });
    });
  }
}

function validateAction(input, agent) {
  const fields = {
    status: ['action'], enable: ['action'], disable: ['action'], pair: ['action'],
    revoke: ['action', 'deviceId'], rename: ['action', 'deviceId', 'label'],
  };
  const allowed = input && typeof input === 'object' && !Array.isArray(input)
    && Object.hasOwn(fields, input.action) && fields[input.action];
  if (!allowed || (agent ? !['status', 'disable', 'revoke', 'rename'].includes(input.action) : input.action === 'status')
    || Object.keys(input).some(key => !allowed.includes(key))
    || allowed.some(key => !Object.hasOwn(input, key))
    || (allowed.includes('deviceId') && (typeof input.deviceId !== 'string' || !input.deviceId))) {
    throw new RemoteControlError('INVALID_REQUEST', 'Provide the fields required by a supported remote-control action.');
  }
}

function isLoopback(value) {
  const host = String(value || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
    || /^::ffff:127\.\d+\.\d+\.\d+$/.test(host);
}

function isLocalRequest(request) {
  try {
    const hostname = new URL(`http://${request.headers.host}`).hostname;
    return isLoopback(request.socket.remoteAddress) && isLoopback(hostname);
  } catch (error) {
    return false;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function methodNotAllowed(response, method) {
  response.setHeader('Allow', method);
  sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${method}.` } });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks = [];
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const fail = () => { cleanup(); request.resume(); reject(new RemoteControlError('INVALID_REQUEST', 'Provide a small valid JSON request.')); };
    const onError = () => fail();
    const onAborted = () => fail();
    const onData = chunk => {
      length += chunk.length;
      if (length > 4096) return fail();
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(new RemoteControlError('INVALID_REQUEST', 'Provide a valid JSON request.')); }
    };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}
