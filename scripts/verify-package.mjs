import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const sources = {
  'dsh-mobile': ['app.js', 'overview.js', 'styles.js', 'build.js', 'THIRD_PARTY_NOTICES.md'],
  'dsh-remote-control': ['build-client.js', 'src/bridge.js', 'src/controller.js', 'src/renewal.js', 'src/tunnel.js', 'src/cloudflared.yml'],
};
assert.ok(Object.hasOwn(sources, manifest.name), 'Unknown package: review the release file requirements');
assert.equal(manifest.license, 'MIT');
assert.equal(manifest.packageManager, 'pnpm@11.9.0');
assert.ok(manifest.keywords.includes('dsh-plugin'));
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
  assert.ok(!Object.hasOwn(manifest.scripts ?? {}, hook), `Unexpected automatic lifecycle script: ${hook}`);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const output = execFileSync(npm, ['pack', '--dry-run', '--ignore-scripts', '--json'], {
  cwd: root,
  encoding: 'utf8',
  // Windows command shims need cmd.exe; every argument above is a fixed literal.
  shell: process.platform === 'win32',
  windowsHide: true,
  maxBuffer: 10 * 1024 * 1024,
});
const [pack] = JSON.parse(output);
assert.equal(pack.name, manifest.name);
assert.equal(pack.version, manifest.version);
const packed = new Set(pack.files.map(file => file.path));
const required = [
  'package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg',
  'locale/en.json', 'locale/zh.json', 'README.md', 'README.en.md', 'README.zh-CN.md', 'LICENSE',
  'scripts/verify-package.mjs', ...sources[manifest.name],
];
async function requireDirectory(relative) {
  const entries = await readdir(new URL(`../${relative}/`, import.meta.url), { withFileTypes: true });
  for (const entry of entries) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await requireDirectory(path);
    else if (entry.isFile()) required.push(path);
    else throw new Error(`Unsupported release source: ${path}`);
  }
}
await requireDirectory('test');
await requireDirectory('scripts');
for (const path of required) assert.ok(packed.has(path), `Missing packed file: ${path}`);
assert.ok(required.some(path => /^test\/.*\.test\.js$/.test(path)), 'Package must retain runnable tests');
for (const path of packed) {
  assert.ok(!/\.png$/i.test(path) || /^docs\/screenshots\/[^/]+\.png$/.test(path), `Unexpected screenshot path: ${path}`);
  assert.ok(!/(^|\/)(node_modules|dist|coverage|artifacts|\.git|\.github)(\/|$)/.test(path), `Private or generated artifact packed: ${path}`);
  assert.ok(!/(^|\/)(\.DS_Store|\.env(?:\..*)?)$|\.tgz$|\.(?:jpe?g|webp|gif)$/i.test(path), `Unexpected release artifact: ${path}`);
}
if (manifest.name === 'dsh-mobile') {
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, 'Bundled browser dependencies belong in devDependencies');
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  for (const text of ['Marked 16.4.2', 'DOMPurify 3.4.17', 'regenerator', 'Facebook, Inc.', 'John Gruber', 'Apache License', 'Permission is hereby granted']) {
    assert.ok(notices.includes(text), `Missing third-party attribution: ${text}`);
  }
}
console.log(`Verified ${manifest.name}@${manifest.version}: ${packed.size} packed files, including runtime, build sources, tests and licenses.`);
