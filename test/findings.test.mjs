import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReviewReport } from '../src/core/findings.js';

const finding = (id, over = {}) => ({
  id, cycleId: 'run-1', severity: 'HIGH', category: 'CORRECTNESS', description: `issue ${id}`,
  suggestion: 'fix', status: 'OPEN', material: true, materiality_justification: null, history: [], ...over,
});
const report = (findings, status = 'ISSUES_FOUND') => ({ protocol_version: '1.0', status, summary: 's', findings });
const run = (rep, { findings = [], prevOpenIds = [], cycleId = 'run-1', next = 20 } = {}) =>
  applyReviewReport({ report: rep, findings: new Map(findings.map((f) => [f.id, f])), prevOpenIds, cycleId, nextFindingNumber: next });

test('spec Appendix A.1 example is valid: reopen, justified downgrade, new LOW candidate', () => {
  const existing = [
    finding('PM-F-00014', { status: 'RESOLVED' }),
    finding('PM-F-00015', { severity: 'MEDIUM' }),
  ];
  const rep = report([
    { existing_finding_id: 'PM-F-00014', status: 'REOPENED', severity: 'HIGH', material: true, suggestion: 'Correct the claim and cite the source.' },
    { existing_finding_id: 'PM-F-00015', status: 'OPEN', severity: 'LOW', material: false, materiality_justification: null,
      severity_change_reason: 'Only the example label is wrong; the explanation itself is now correct.' },
    { provider_finding_ref: 'reviewer-local-7', status: 'OPEN', severity: 'LOW', category: 'CLARITY',
      description: 'A heading could be shorter.', suggestion: 'Consider a shorter heading.', material: false, materiality_justification: null },
  ]);
  const out = run(rep, { findings: existing, prevOpenIds: ['PM-F-00015'], next: 16 });
  assert.deepEqual(out.errors, []);
  const r = out.result;
  assert.equal(r.created[0].id, 'PM-F-00016'); // PeerMind assigns the canonical ID
  assert.deepEqual(r.openIds.sort(), ['PM-F-00014', 'PM-F-00015', 'PM-F-00016']);
  assert.equal(r.complete, false); // PM-F-00014 is material
  assert.equal(r.updated.find((f) => f.id === 'PM-F-00014').status, 'REOPENED');
  assert.equal(r.downgrades.length, 1);
});

test('RESOLVED finding referenced as OPEN is recorded as REOPENED (§3.1)', () => {
  const out = run(report([{ existing_finding_id: 'PM-F-00001', status: 'OPEN' }]), { findings: [finding('PM-F-00001', { status: 'RESOLVED' })] });
  assert.equal(out.result.updated[0].status, 'REOPENED');
});

test('oneOf: entry with both or neither alternative is rejected (AC-12)', () => {
  assert.match(run(report([{ existing_finding_id: 'PM-F-00001', provider_finding_ref: 'x', status: 'OPEN' }]), { findings: [finding('PM-F-00001')] }).errors[0], /exactly one/);
  assert.match(run(report([{ status: 'OPEN' }])).errors[0], /exactly one/);
});

test('new candidates must be OPEN', () => {
  const out = run(report([{ provider_finding_ref: 'a', status: 'RESOLVED', severity: 'LOW', category: 'FORMAT', description: 'd', suggestion: 's', material: false }]));
  assert.ok(out.errors.some((e) => /must have status OPEN/.test(e)));
});

test('unknown or malformed existing ID is a violation, never a new finding (AC-13)', () => {
  assert.match(run(report([{ existing_finding_id: 'PM-F-99999', status: 'OPEN' }])).errors[0], /unknown or malformed/);
  assert.match(run(report([{ existing_finding_id: 'F-1', status: 'OPEN' }])).errors[0], /unknown or malformed/);
});

test('category/description on an existing reference is rejected (AC-14)', () => {
  const out = run(report([{ existing_finding_id: 'PM-F-00001', status: 'OPEN', description: 'new wording' }]), { findings: [finding('PM-F-00001')], prevOpenIds: ['PM-F-00001'] });
  assert.ok(out.errors.some((e) => /immutable/.test(e)));
});

test('severity change without explicit material is rejected; prior material not inherited (AC-15)', () => {
  const out = run(report([{ existing_finding_id: 'PM-F-00001', status: 'OPEN', severity: 'CRITICAL' }]), { findings: [finding('PM-F-00001')], prevOpenIds: ['PM-F-00001'] });
  assert.ok(out.errors.some((e) => /without an explicit material/.test(e)));
});

test('materiality rules (AC-16)', () => {
  const cand = (o) => ({ provider_finding_ref: 'a', status: 'OPEN', category: 'CORRECTNESS', description: 'd', suggestion: 's', ...o });
  assert.ok(run(report([cand({ severity: 'MEDIUM', material: false })])).errors.some((e) => /must have material=true/.test(e)));
  assert.ok(run(report([cand({ severity: 'LOW', material: true, materiality_justification: 'too short' })])).errors.some((e) => /justification/.test(e)));
  assert.deepEqual(run(report([cand({ severity: 'LOW', material: true, materiality_justification: 'This breaks the user requirement for exact output format.' })])).errors, []);
});

test('downgrade of a material open finding needs severity_change_reason (AC-17)', () => {
  const out = run(report([{ existing_finding_id: 'PM-F-00001', status: 'OPEN', severity: 'LOW', material: false }]), { findings: [finding('PM-F-00001')], prevOpenIds: ['PM-F-00001'] });
  assert.ok(out.errors.some((e) => /severity_change_reason/.test(e)));
  const ok = run(report([{ existing_finding_id: 'PM-F-00001', status: 'OPEN', severity: 'LOW', material: false, severity_change_reason: 'Only affects an optional footnote, not the answer.' }], 'NO_MATERIAL_ISSUES'),
    { findings: [finding('PM-F-00001')], prevOpenIds: ['PM-F-00001'] });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.result.complete, true);
  assert.equal(ok.result.downgrades[0].finding_id, 'PM-F-00001'); // completion depends on it → label
});

test('omission of a previously open finding is a violation (AC-18), including non-material', () => {
  const out = run(report([]), { findings: [finding('PM-F-00001'), finding('PM-F-00002', { severity: 'LOW', material: false })], prevOpenIds: ['PM-F-00001', 'PM-F-00002'] });
  assert.ok(out.errors.some((e) => /Omitted.*PM-F-00001.*PM-F-00002/.test(e)));
});

test('LOW-only open findings do not block completion; R.status mismatch is flagged not fatal (AC-19)', () => {
  const out = run(report([{ provider_finding_ref: 'a', status: 'OPEN', severity: 'LOW', category: 'CLARITY', description: 'd', suggestion: 's', material: false }], 'ISSUES_FOUND'));
  assert.deepEqual(out.errors, []);
  assert.equal(out.result.complete, true);
  assert.equal(out.result.statusMismatch, true);
});

test('earlier-cycle finding referenced as OPEN becomes a current-cycle finding (AC-22)', () => {
  const old = finding('PM-F-00003', { cycleId: 'run-0' });
  const out = run(report([{ existing_finding_id: 'PM-F-00003', status: 'OPEN' }]), { findings: [old], cycleId: 'run-1' });
  assert.deepEqual(out.result.openIds, ['PM-F-00003']);
  assert.deepEqual(out.result.updated[0].carriedInto, ['run-1']);
});

test('duplicate references and refs are rejected', () => {
  const f = [finding('PM-F-00001')];
  assert.ok(run(report([{ existing_finding_id: 'PM-F-00001', status: 'OPEN' }, { existing_finding_id: 'PM-F-00001', status: 'RESOLVED' }]), { findings: f }).errors.some((e) => /more than once/.test(e)));
});
