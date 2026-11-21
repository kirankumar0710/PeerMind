import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, assertTransition, holdsGlobalLock, holdsConversationLock, stopOutcome, TRANSITIONS } from '../src/core/state-machine.js';
import { RunState as S, CompletionReason as CR, AbandonmentReason as AR } from '../src/core/constants.js';

test('§5.3 table: every listed transition is allowed, everything else rejected (AC-25)', () => {
  const states = Object.values(S);
  for (const from of states) {
    for (const to of states) {
      assert.equal(canTransition(from, to), TRANSITIONS[from].includes(to), `${from}→${to}`);
    }
  }
  assert.throws(() => assertTransition(S.INTERRUPTED, S.RUNNING), /Rejected/); // FR-089: resume must go via PREFLIGHT
  assert.throws(() => assertTransition(S.FAILED, S.RUNNING), /Rejected/);      // FR-033
  assert.throws(() => assertTransition(S.FINISHED, S.PREFLIGHT), /Rejected/);
});

test('locks per §5.4 (AC-29)', () => {
  assert.equal(holdsGlobalLock(S.CREATED), false); // FR-094
  assert.equal(holdsGlobalLock(S.PREFLIGHT), true);
  assert.equal(holdsGlobalLock(S.RUNNING), true);
  for (const s of [S.PAUSED_WAITING_FOR_USER, S.INTERRUPTED, S.FAILED, S.FINISHED, S.ABANDONED]) assert.equal(holdsGlobalLock(s), false);
  for (const s of [S.CREATED, S.PREFLIGHT, S.RUNNING, S.PAUSED_WAITING_FOR_USER, S.INTERRUPTED, S.FAILED]) assert.equal(holdsConversationLock(s), true);
  assert.equal(holdsConversationLock(S.FINISHED), false);
  assert.equal(holdsConversationLock(S.ABANDONED), false);
});

test('Stop semantics (FR-097, FR-098, AC-28)', () => {
  assert.deepEqual(stopOutcome(S.RUNNING), { to: S.FINISHED, completionReason: CR.USER_STOPPED });
  assert.equal(stopOutcome(S.CREATED).abandonmentReason, AR.BEFORE_START);
  assert.equal(stopOutcome(S.FAILED).abandonmentReason, AR.AFTER_FAILURE);
  assert.equal(stopOutcome(S.PAUSED_WAITING_FOR_USER).abandonmentReason, AR.WHILE_PAUSED);
  assert.equal(stopOutcome(S.INTERRUPTED).abandonmentReason, AR.AFTER_INTERRUPTION);
  // PREFLIGHT entered from a retry/resume keeps the reason of the state it came from
  assert.equal(stopOutcome(S.PREFLIGHT, S.CREATED).abandonmentReason, AR.BEFORE_START);
  assert.equal(stopOutcome(S.PREFLIGHT, S.FAILED).abandonmentReason, AR.AFTER_FAILURE);
  assert.equal(stopOutcome(S.PREFLIGHT, S.INTERRUPTED).abandonmentReason, AR.AFTER_INTERRUPTION);
  assert.equal(stopOutcome(S.FINISHED), null);
  // FAILED is never a completion reason (AC-24)
  assert.ok(!Object.values(CR).includes('FAILED'));
});
