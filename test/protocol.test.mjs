import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStrictJson, validateInitialG, validateRefinement } from '../src/core/protocol.js';

test('strict parsing rejects prose, fences and truncated JSON (FR-029, AC-10)', () => {
  assert.ok(parseStrictJson('Here you go: {"a":1}').errors.length);
  assert.ok(parseStrictJson('```json\n{"a":1}\n```').errors.length);
  assert.ok(parseStrictJson('{"a":1').errors.length);
  assert.ok(parseStrictJson('[1,2]').errors.length);
  assert.ok(parseStrictJson('').errors.length);
  assert.deepEqual(parseStrictJson('  {"a":1}\n').value, { a: 1 });
});

test('initial G schema (FR-012)', () => {
  assert.deepEqual(validateInitialG({ protocol_version: '1.0', summary: 's', response: 'r' }), []);
  assert.deepEqual(validateInitialG({ protocol_version: '1.0', summary: 's', response: 'r', assets: [] }), []);
  assert.ok(validateInitialG({ protocol_version: '1.0', summary: 's', response: 'r', assets: [{ asset_id: 'PM-A-0001' }] }).length); // model never assigns assets
  assert.ok(validateInitialG({ protocol_version: '2.0', summary: 's', response: 'r' }).length);
  assert.ok(validateInitialG({ protocol_version: '1.0', summary: 's' }).length);
});

test('spec Appendix A.2 refinement report is valid', () => {
  const a2 = {
    protocol_version: '1.0',
    summary: 'Fixed the reopened claim, corrected the label, kept the heading.',
    decisions: [
      { finding_id: 'PM-F-00014', decision: 'APPLIED', reason: 'Replaced the claim and added the citation.' },
      { finding_id: 'PM-F-00015', decision: 'APPLIED', reason: 'Renamed the example label.' },
      { finding_id: 'PM-F-00016', decision: 'REJECTED', reason: "The heading matches the user's required section names." },
    ],
    response: 'Revised response...',
    assets: [],
  };
  assert.deepEqual(validateRefinement(a2, ['PM-F-00014', 'PM-F-00015', 'PM-F-00016']), []);
});

test('refinement: exactly one decision per open finding, with a reason (FR-022, FR-023, AC-20)', () => {
  const base = { protocol_version: '1.0', summary: 's', response: 'r' };
  const missing = validateRefinement({ ...base, decisions: [] }, ['PM-F-00001']);
  assert.ok(missing.some((e) => /Missing decisions for: PM-F-00001/.test(e)));
  const extra = validateRefinement({ ...base, decisions: [{ finding_id: 'PM-F-00002', decision: 'APPLIED', reason: 'x' }] }, []);
  assert.ok(extra.some((e) => /not an open finding/.test(e))); // no decisions for RESOLVED/other findings
  const dup = validateRefinement({ ...base, decisions: [
    { finding_id: 'PM-F-00001', decision: 'APPLIED', reason: 'x' },
    { finding_id: 'PM-F-00001', decision: 'APPLIED', reason: 'x' }] }, ['PM-F-00001']);
  assert.ok(dup.some((e) => /duplicate/.test(e)));
  const noReason = validateRefinement({ ...base, decisions: [{ finding_id: 'PM-F-00001', decision: 'APPLIED', reason: '  ' }] }, ['PM-F-00001']);
  assert.ok(noReason.some((e) => /reason is required/.test(e)));
  const badEnum = validateRefinement({ ...base, decisions: [{ finding_id: 'PM-F-00001', decision: 'FIXED', reason: 'x' }] }, ['PM-F-00001']);
  assert.ok(badEnum.some((e) => /decision must be one of/.test(e)));
});
