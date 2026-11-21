// FR-104: build ONE package for both Brave and Chrome and print its SHA-256 for the result records.
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { createZip } from '../src/export/zip.js';

const root = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const entries = [];
const add = (p) => {
  if (statSync(p).isDirectory()) { for (const n of readdirSync(p).sort()) add(join(p, n)); return; }
  entries.push({ name: relative(root, p), data: new Uint8Array(readFileSync(p)) });
};
add(join(root, 'manifest.json'));
add(join(root, 'icons'));
add(join(root, 'src'));

// Fixed timestamp so identical sources produce an identical package hash.
const zip = createZip(entries, new Date(2026, 0, 1));
mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `peermind-${manifest.version}.zip`);
writeFileSync(out, zip);
console.log(`${relative(root, out)}\nsha256 ${createHash('sha256').update(zip).digest('hex')}`);
