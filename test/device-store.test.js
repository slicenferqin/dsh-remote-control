import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDeviceStore } from '../src/device-store.js'

const FAILURE = /^Error: Remote device store is unavailable$/
const ORIGIN = 'https://example.com'
const registry = () => ({ version: 1, origin: ORIGIN, devices: [{
  id: '60e390ab-e3b5-4a47-9ed1-096fd2545783', label: 'My phone',
  pairedAt: 1_700_000_000_000, lastSeenAt: 1_700_000_001_000,
  refreshHash: 'a'.repeat(64), refreshExpiresAt: 1_800_000_000_000,
}] })

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-device-store-'))
  t.after(() => {
    assert.equal(resolve(directory), directory)
    assert.ok(directory.startsWith(join(tmpdir(), 'dsh-device-store-')))
    chmodSync(directory, 0o700)
    rmSync(directory, { recursive: true, force: true })
  })
  const path = join(directory, 'state', 'devices.json')
  return { directory, path, store: createDeviceStore(path) }
}

test('synchronous store survives reconstruction, writes 0600 atomically and keeps intent separate', t => {
  const { path, store } = fixture(t)
  assert.deepEqual(store.load(), { version: 1, origin: null, devices: [] })
  assert.equal(store.readIntent(), null)
  assert.equal(store.writeIntent(true), undefined)
  assert.equal(store.save(registry()), undefined)
  const disk = createDeviceStore(path)
  assert.deepEqual(disk.load(), registry())
  assert.equal(disk.readIntent(), true)
  assert.equal(lstatSync(path).mode & 0o777, 0o600)
  assert.equal(lstatSync(join(path, '..')).mode & 0o777, 0o700)
  disk.writeIntent(false)
  store.save({ ...registry(), devices: [] })
  assert.equal(store.readIntent(), false)
  assert.deepEqual(readdirSync(join(path, '..')), ['devices.json'])
  store.clear()
  assert.deepEqual(disk.load(), { version: 1, origin: null, devices: [] })
  assert.equal(disk.readIntent(), false)
  disk.writeIntent(true)
  disk.clear()
  assert.equal(createDeviceStore(path).readIntent(), true)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), ['devices', 'enabled', 'origin', 'version'])
})

test('bad JSON, unknown fields, malformed origins, hashes and timestamps fail closed with fixed errors', t => {
  const { path, store } = fixture(t)
  store.save(registry())
  const mutations = [
    value => { value.version = 2 },
    value => { value.enabled = 'true' },
    value => { value.origin = 'https://user@example.com' },
    value => { value.origin = 'https://example.com/path' },
    value => { value.origin = 'https://example.com:444' },
    value => { value.origin = null },
    value => { value.rawRefresh = 'private-refresh-credential' },
    value => { value.devices[0].token = 'private-credential' },
    value => { value.devices[0].id = '../private-credential' },
    value => { value.devices[0].label = 'x'.repeat(81) },
    value => { value.devices[0].label = 'Phone\n' },
    value => { value.devices[0].refreshHash = 'raw-refresh-credential' },
    value => { value.devices[0].refreshExpiresAt = Infinity },
    value => { value.devices[0].lastSeenAt = value.devices[0].refreshExpiresAt },
    value => { value.devices[0].pairedAt = -1 },
    value => { value.devices.push({ ...value.devices[0] }) },
  ]
  for (const mutate of mutations) {
    const value = registry()
    mutate(value)
    writeFileSync(path, JSON.stringify(value))
    for (const operation of [() => store.load(), () => store.readIntent(), () => store.save(registry()), () => store.clear(), () => store.writeIntent(false)]) {
      assert.throws(operation, FAILURE)
    }
  }
  for (const text of ['private-corrupt-credential', ' ', 'x'.repeat(300_000)]) {
    writeFileSync(path, text)
    assert.throws(() => store.load(), FAILURE)
  }
})

test('unsafe file modes, symlinks, hardlinks and writable state directories fail closed', t => {
  const { directory, path, store } = fixture(t)
  store.save(registry())
  chmodSync(path, 0o644)
  assert.throws(() => store.load(), FAILURE)
  assert.throws(() => store.save(registry()), FAILURE)
  chmodSync(path, 0o600)
  const linked = join(directory, 'linked.json')
  symlinkSync(path, linked)
  assert.throws(() => createDeviceStore(linked).load(), FAILURE)
  const hard = join(directory, 'hard.json')
  linkSync(path, hard)
  assert.throws(() => store.load(), FAILURE)
  const otherDirectory = join(directory, 'writable')
  mkdirSync(otherDirectory, { mode: 0o700 })
  const other = createDeviceStore(join(otherDirectory, 'devices.json'))
  other.save(registry())
  chmodSync(otherDirectory, 0o777)
  assert.throws(() => other.load(), FAILURE)
  assert.throws(() => other.writeIntent(true), FAILURE)
  chmodSync(otherDirectory, 0o700)
  const directoryLink = join(directory, 'directory-link')
  symlinkSync(otherDirectory, directoryLink)
  assert.throws(() => createDeviceStore(join(directoryLink, 'devices.json')).load(), FAILURE)
})

test('store rejects relative paths and invalid save/intent input without writing raw credentials', t => {
  const { path, store } = fixture(t)
  for (const value of ['', './devices.json', null, 42]) assert.throws(() => createDeviceStore(value), FAILURE)
  for (const value of [null, {}, { ...registry(), enabled: true }, { ...registry(), access: 'secret' }]) {
    assert.throws(() => store.save(value), FAILURE)
  }
  for (const value of [null, 1, 'true', undefined]) assert.throws(() => store.writeIntent(value), FAILURE)
  store.save(registry())
  assert.doesNotMatch(readFileSync(path, 'utf8'), /rawRefresh|access|cookie|secret|token/)
})
