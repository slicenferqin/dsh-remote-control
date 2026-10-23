import { readFile, writeFile } from 'node:fs/promises';
import { createCredentialRenewer } from './src/renewal.js';
import { createConnectionCredentialRecovery } from './src/connection-recovery.js';

const clientUrl = new URL('./client.js', import.meta.url);
const source = await readFile(clientUrl, 'utf8');
function embed(source, label, helper, path) {
  const begin = `    // BEGIN GENERATED ${label}`;
  const end = `    // END GENERATED ${label}`;
  const start = source.indexOf(begin), finish = source.indexOf(end);
  if (start < 0 || finish <= start || source.indexOf(begin, start + begin.length) !== -1
    || source.indexOf(end, finish + end.length) !== -1) {
    throw new Error(`client.js must contain exactly one generated ${label} block`);
  }
  const body = helper.toString().split('\n').map(line => line ? `    ${line}` : '').join('\n');
  return `${source.slice(0, start)}${begin}\n    // Generated from ${path}; run node build-client.js after changes.\n${body}\n${source.slice(finish)}`;
}
let result = embed(source, 'CREDENTIAL RENEWER', createCredentialRenewer, 'src/renewal.js');
result = embed(result, 'CONNECTION RECOVERY', createConnectionCredentialRecovery, 'src/connection-recovery.js');
if (result !== source) await writeFile(clientUrl, result);
