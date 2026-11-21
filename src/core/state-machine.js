// §5.3 transition table, §5.4 lock ownership and Stop semantics. Pure functions.
import { RunState as S, AbandonmentReason, CompletionReason } from './constants.js';

export const TRANSITIONS = Object.freeze({
  [S.CREATED]: [S.PREFLIGHT, S.ABANDONED],
  [S.PREFLIGHT]: [S.RUNNING, S.FAILED, S.ABANDONED],
  [S.RUNNING]: [S.PAUSED_WAITING_FOR_USER, S.INTERRUPTED, S.FAILED, S.FINISHED],
  [S.PAUSED_WAITING_FOR_USER]: [S.PREFLIGHT, S.RUNNING, S.INTERRUPTED, S.ABANDONED],
  [S.INTERRUPTED]: [S.PREFLIGHT, S.PAUSED_WAITING_FOR_USER, S.ABANDONED],
  [S.FAILED]: [S.PREFLIGHT, S.PAUSED_WAITING_FOR_USER, S.ABANDONED],
  [S.FINISHED]: [],
  [S.ABANDONED]: [],
});

export class TransitionError extends Error {
  constructor(from, to) {
    super(`Rejected run transition ${from} → ${to}`);
    this.name = 'TransitionError';
    this.from = from;
    this.to = to;
  }
}

export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

export const isTerminal = (state) => state === S.FINISHED || state === S.ABANDONED;

// FR-047, FR-094: only PREFLIGHT and RUNNING hold the global execution lock.
export const holdsGlobalLock = (state) => state === S.PREFLIGHT || state === S.RUNNING;

// FR-048: every non-terminal state holds the conversation lock.
export const holdsConversationLock = (state) => !isTerminal(state);

/**
 * §5.4 Stop semantics. Returns the target state and reason fields.
 * `preflightFrom` records which state a PREFLIGHT was entered from, so a Stop during
 * a retry/resume pre-flight gets the matching abandonment reason.
 */
export function stopOutcome(state, preflightFrom = S.CREATED) {
  switch (state) {
    case S.RUNNING:
      return { to: S.FINISHED, completionReason: CompletionReason.USER_STOPPED };
    case S.CREATED:
      return { to: S.ABANDONED, abandonmentReason: AbandonmentReason.BEFORE_START };
    case S.PREFLIGHT:
      return { to: S.ABANDONED, abandonmentReason: abandonReasonFor(preflightFrom) };
    case S.PAUSED_WAITING_FOR_USER:
    case S.INTERRUPTED:
    case S.FAILED:
      return { to: S.ABANDONED, abandonmentReason: abandonReasonFor(state) };
    default:
      return null; // terminal: nothing to stop
  }
}

function abandonReasonFor(state) {
  switch (state) {
    case S.FAILED: return AbandonmentReason.AFTER_FAILURE;
    case S.PAUSED_WAITING_FOR_USER: return AbandonmentReason.WHILE_PAUSED;
    case S.INTERRUPTED: return AbandonmentReason.AFTER_INTERRUPTION;
    default: return AbandonmentReason.BEFORE_START;
  }
}
