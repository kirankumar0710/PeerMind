// Shared enums and defaults. Spec references are to PeerMind Functional Specification v1.8.

export const PROTOCOL_VERSION = '1.0';
export const ARCHIVE_FORMAT_VERSION = '1.0';
export const EXPORTER_VERSION = '0.1.0';

// §5.2 run states
export const RunState = Object.freeze({
  CREATED: 'CREATED',
  PREFLIGHT: 'PREFLIGHT',
  RUNNING: 'RUNNING',
  PAUSED_WAITING_FOR_USER: 'PAUSED_WAITING_FOR_USER',
  INTERRUPTED: 'INTERRUPTED',
  FAILED: 'FAILED',
  FINISHED: 'FINISHED',
  ABANDONED: 'ABANDONED',
});

// §5.2 completion reasons (FAILED is never one of these)
export const CompletionReason = Object.freeze({
  NO_MATERIAL_ISSUES: 'NO_MATERIAL_ISSUES',
  MAX_ITERATIONS_REACHED: 'MAX_ITERATIONS_REACHED',
  USER_STOPPED: 'USER_STOPPED',
  BUDGET_REACHED: 'BUDGET_REACHED',
  CONTEXT_LIMIT_EXCEEDED: 'CONTEXT_LIMIT_EXCEEDED',
});

// §5.2 [Proposed v1.7]
export const AbandonmentReason = Object.freeze({
  BEFORE_START: 'USER_ABANDONED_BEFORE_START',
  AFTER_FAILURE: 'USER_ABANDONED_AFTER_FAILURE',
  WHILE_PAUSED: 'USER_ABANDONED_WHILE_PAUSED',
  AFTER_INTERRUPTION: 'USER_ABANDONED_AFTER_INTERRUPTION',
});

// §5.5 operation states
export const OpState = Object.freeze({
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});

export const OpKind = Object.freeze({
  G_INITIAL: 'G_INITIAL',
  R_REVIEW: 'R_REVIEW',
  G_REFINE: 'G_REFINE',
});

export const FindingStatus = Object.freeze({
  OPEN: 'OPEN',
  RESOLVED: 'RESOLVED',
  REOPENED: 'REOPENED',
});

export const Severity = Object.freeze({
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
});
export const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

// §3.4
export const Categories = Object.freeze([
  'CORRECTNESS', 'COMPLETENESS', 'SECURITY', 'REQUIREMENT_GAP', 'CLARITY', 'FORMAT',
]);

export const Decision = Object.freeze(['APPLIED', 'REJECTED', 'ALREADY_ADDRESSED', 'NO_CHANGE_NEEDED']);

// §12 review-status labels
export const ReviewStatus = Object.freeze({
  REVIEWED: 'REVIEWED',
  LAST_REVIEWED_MATERIAL_REMAIN: 'LAST REVIEWED OUTPUT — MATERIAL FINDINGS REMAIN',
  NOT_REVIEWED: 'NOT REVIEWED / REVIEW INCOMPLETE',
});
export const DOWNGRADE_LABEL = 'COMPLETED AFTER SEVERITY DOWNGRADE';

// §10 timeouts (ms), all configurable (FR-038)
export const DEFAULT_TIMEOUTS = Object.freeze({
  streamingHeadersMs: 30_000,
  firstContentMs: 180_000,
  inactivityMs: 60_000,
  nonStreamingMs: 300_000,
});

// §2.1 [Proposed v1.7]
export const ITERATION_LIMIT = Object.freeze({ min: 0, max: 10, default: 3 });

// §9.6 import limits (application constants)
export const IMPORT_LIMITS = Object.freeze({
  zipCompressed: 100 * 1024 * 1024,
  eachAsset: 20 * 1024 * 1024,
  allAssets: 80 * 1024 * 1024,
  eachJson: 20 * 1024 * 1024,
  allJson: 40 * 1024 * 1024,
  totalExpanded: 120 * 1024 * 1024,
  entries: 2000,
});

export const DISCLOSURE_VERSION = 1;
export const DISCLOSURE_TEXT =
  'Prompts, selected conversation context, attached images and generated content may be sent to this ' +
  'external AI provider and processed under its terms and privacy policy. PeerMind stores conversation ' +
  'data locally in this browser. Provider API usage is billed by the provider separately from any ' +
  'consumer subscription.';

export const MIN_JUSTIFICATION_CHARS = 20;
