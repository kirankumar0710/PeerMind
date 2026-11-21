import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, crc32 } from '../src/export/zip.js';
import { buildExportEntries } from '../src/export/export.js';

test('crc32 known vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip is readable by the system unzip and rejects unsafe paths', () => {
  const zip = createZip([{ name: 'a.json', data: '{"x":1}' }, { name: 'assets/PM-A-0001.png', data: new Uint8Array([1, 2, 3]) }]);
  const dir = mkdtempSync(join(tmpdir(), 'pmzip-'));
  const f = join(dir, 'x.zip');
  writeFileSync(f, zip);
  const out = execFileSync('unzip', ['-t', f]).toString();
  assert.match(out, /No errors detected/);
  assert.throws(() => createZip([{ name: '../evil', data: '' }]));
  assert.throws(() => createZip([{ name: '/abs', data: '' }]));
});

test('export members and asset paths (FR-055, FR-075); no secrets', () => {
  const entries = buildExportEntries({
    conversation: { id: 'conv-1', title: 't', createdAt: 'x', updatedAt: 'y', capUsd: 1, budgetEnforced: true },
    runs: [], operations: [], messages: [], findings: [],
    assets: [{ asset_id: 'PM-A-0001', media_type: 'image/png', operation: 'UPLOADED', source_asset_id: null, sha256: 'ab', byte_length: 3, bytes: new Uint8Array([1, 2, 3]) }],
  });
  assert.deepEqual(entries.map((e) => e.name), ['conversation.json', 'memory.json', 'metadata.json', 'assets/PM-A-0001.png']);
  const conv = JSON.parse(entries[0].data);
  assert.equal(conv.assets[0].relative_path, 'assets/PM-A-0001.png');
  assert.doesNotMatch(entries.map((e) => (typeof e.data === 'string' ? e.data : '')).join(''), /apiKey|api_key|x-api-key/i);
});
