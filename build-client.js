import { readFile, writeFile } from 'node:fs/promises';
import { createCredentialRenewer } from './src/renewal.js';

const clientUrl = new URL('./client.js', import.meta.url);
const source = await readFile(clientUrl, 'utf8');
const begin = '    // BEGIN GENERATED CREDENTIAL RENEWER';
const end = '    // END GENERATED CREDENTIAL RENEWER';
const start = source.indexOf(begin);
const finish = source.indexOf(end);
if (start < 0 || finish <= start || source.indexOf(begin, start + begin.length) !== -1
  || source.indexOf(end, finish + end.length) !== -1) {
  throw new Error('client.js must contain exactly one generated credential renewer block');
}
const helper = createCredentialRenewer.toString().split('\n').map(line => line ? `    ${line}` : '').join('\n');
const result = `${source.slice(0, start)}${begin}\n    // Generated from src/renewal.js; run node build-client.js after changes.\n${helper}\n${source.slice(finish)}`;
if (result !== source) await writeFile(clientUrl, result);
