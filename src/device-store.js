import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const FAILURE = 'Remote device store is unavailable'
const MAX_BYTES = 256 * 1024
const MAX_TIME = 8_640_000_000_000_000
const emptyRegistry = () => ({ version: 1, origin: null, devices: [] })
const fail = () => { throw new Error(FAILURE) }

/** Trusted configuration still needs a complete, unambiguous HTTPS authority. */
export function normalizeRemoteOrigin(value) {
  if (typeof value !== 'string' || !/^https:\/\/[^/?#\\\s]+\/?$/i.test(value)) {
    throw new TypeError('external origin must be an HTTPS origin on port 443')
  }
  let url
  try { url = new URL(value) } catch { throw new TypeError('external origin must be an HTTPS origin on port 443') }
  const hostname = url.hostname
  if (url.protocol !== 'https:' || url.port || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || hostname.length > 253
    || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new TypeError('external origin must be an HTTPS origin on port 443')
  }
  return url.origin
}

function keys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key))
}

/** Validate custom stores too; project only fields allowed to reach disk. */
export function validateDeviceSnapshot(value) {
  if (!keys(value, ['version', 'origin', 'devices']) || value.version !== 1
    || !Array.isArray(value.devices) || value.devices.length > 256) fail()
  let origin = null
  if (value.origin !== null) {
    try { origin = normalizeRemoteOrigin(value.origin) } catch { fail() }
    if (origin !== value.origin) fail()
  }
  if (!origin && value.devices.length) fail()
  const ids = new Set()
  const hashes = new Set()
  const devices = value.devices.map(device => {
    if (!keys(device, ['id', 'label', 'pairedAt', 'lastSeenAt', 'refreshHash', 'refreshExpiresAt'])
      || typeof device.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(device.id)
      || typeof device.label !== 'string' || !device.label || device.label !== device.label.trim() || device.label.length > 80
      || /[\u0000-\u001f\u007f-\u009f]/.test(device.label)
      || typeof device.refreshHash !== 'string' || !/^[a-f0-9]{64}$/.test(device.refreshHash)
      || !['pairedAt', 'lastSeenAt', 'refreshExpiresAt'].every(key => Number.isSafeInteger(device[key]) && device[key] >= 0 && device[key] <= MAX_TIME)
      || device.pairedAt > device.lastSeenAt || device.lastSeenAt >= device.refreshExpiresAt
      || ids.has(device.id) || hashes.has(device.refreshHash)) fail()
    ids.add(device.id)
    hashes.add(device.refreshHash)
    const { id, label, pairedAt, lastSeenAt, refreshHash, refreshExpiresAt } = device
    return { id, label, pairedAt, lastSeenAt, refreshHash, refreshExpiresAt }
  })
  return { version: 1, origin, devices }
}

/** Synchronous, single-writer store. The caller supplies the absolute state path. */
export function createDeviceStore(filePath) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath.includes('\0')) fail()
  const directory = dirname(filePath)
  const owned = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid()

  function checkDirectory(create = false) {
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 })
    let stat
    try { stat = lstatSync(directory) } catch (error) {
      if (error.code === 'ENOENT' && !create) return false
      throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o022)) fail()
    return true
  }

  function read() {
    let descriptor
    try {
      if (!checkDirectory()) return { ...emptyRegistry(), enabled: null }
      try { descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
        if (error.code === 'ENOENT') return { ...emptyRegistry(), enabled: null }
        throw error
      }
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_BYTES) fail()
      const value = JSON.parse(readFileSync(descriptor, 'utf8'))
      if (!keys(value, ['version', 'origin', 'devices', 'enabled'])
        || (value.enabled !== undefined && typeof value.enabled !== 'boolean')) fail()
      const { enabled, ...registry } = value
      return { ...validateDeviceSnapshot(registry), enabled: enabled ?? null }
    } catch { fail() } finally { if (descriptor !== undefined) closeSync(descriptor) }
  }

  function atomicWrite(value) {
    let descriptor
    let temporary
    try {
      checkDirectory(true)
      // read() validates the existing target, including symlinks and its mode.
      read()
      temporary = join(directory, `.dsh-remote-${randomUUID()}.tmp`)
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      fchmodSync(descriptor, 0o600)
      const text = `${JSON.stringify(value)}\n`
      if (Buffer.byteLength(text) > MAX_BYTES) fail()
      writeFileSync(descriptor, text, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, filePath)
      temporary = undefined
      const directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
    } catch { fail() } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      if (temporary) { try { unlinkSync(temporary) } catch { /* Preserve the fixed public error. */ } }
    }
  }

  function writeRegistry(registry) {
    const { enabled } = read()
    atomicWrite({ ...registry, ...(enabled === null ? {} : { enabled }) })
  }

  return {
    load() {
      const { enabled: _enabled, ...registry } = read()
      return registry
    },
    save(snapshot) { writeRegistry(validateDeviceSnapshot(snapshot)) },
    clear() { writeRegistry(emptyRegistry()) },
    readIntent() { return read().enabled },
    writeIntent(enabled) {
      if (typeof enabled !== 'boolean') fail()
      const { enabled: _enabled, ...registry } = read()
      atomicWrite({ ...registry, enabled })
    },
  }
}
