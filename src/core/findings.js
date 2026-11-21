// §3.1–§3.7 reviewer report validation and finding-state application. Pure functions.
import {
  PROTOCOL_VERSION, FindingStatus as FS, Severity, Categories, MIN_JUSTIFICATION_CHARS,
} from './constants.js';
import { isPlainObject, nonWhitespaceLength, formatFindingId, FINDING_ID_RE } from './util.js';

const EXISTING_KEYS = [
  'existing_finding_id', 'status', 'severity', 'material',
  'materiality_justification', 'suggestion', 'severity_change_reason',
];
const CANDIDATE_KEYS = [
  'provider_finding_ref', 'status', 'severity', 'category', 'description',
  'suggestion', 'material', 'materiality_justification',
];
const SEVERITIES = Object.values(Severity);
const isOpen = (status) => status === FS.OPEN || status === FS.REOPENED;

/** §3.4 rules on a full (merged) finding record. */
function materialityErrors(rec, where) {
  const errors = [];
  if (rec.severity !== Severity.LOW && rec.material !== true) {
    errors.push(`${where}: ${rec.severity} findings must have material=true.`);
  }
  if (rec.severity === Severity.LOW && rec.material === true &&
      nonWhitespaceLength(rec.materiality_justification) < MIN_JUSTIFICATION_CHARS) {
    errors.push(`${where}: LOW with material=true needs materiality_justification of at least ${MIN_JUSTIFICATION_CHARS} non-whitespace characters.`);
  }
  return errors;
}

function checkTypes(entry, where, errors) {
  if ('severity' in entry && !SEVERITIES.includes(entry.severity)) errors.push(`${where}: invalid severity.`);
  if ('material' in entry && typeof entry.material !== 'boolean') errors.push(`${where}: material must be boolean.`);
  if ('suggestion' in entry && typeof entry.suggestion !== 'string') errors.push(`${where}: suggestion must be a string.`);
  if ('materiality_justification' in entry && entry.materiality_justification !== null &&
      typeof entry.materiality_justification !== 'string') {
    errors.push(`${where}: materiality_justification must be a string or null.`);
  }
}

/**
 * Validate a reviewer report against current finding state and, if valid, compute the new state.
 *
 * @param {object} p
 * @param {object} p.report            parsed R JSON
 * @param {Map<string,object>} p.findings  all findings in the conversation, keyed by canonical ID
 * @param {string[]} p.prevOpenIds     IDs OPEN/REOPENED in the previous accepted R report of this cycle (§3.6)
 * @param {string} p.cycleId           current cycle (run) ID
 * @param {number} p.nextFindingNumber next free canonical ID number
 * @returns {{errors: string[]} | {errors: [], result: object}}
 */
export function applyReviewReport({ report, findings, prevOpenIds, cycleId, nextFindingNumber }) {
  const errors = [];
  for (const k of Object.keys(report)) {
    if (!['protocol_version', 'status', 'summary', 'findings'].includes(k)) errors.push(`root: unexpected field "${k}".`);
  }
  if (report.protocol_version !== PROTOCOL_VERSION) errors.push(`protocol_version must be "${PROTOCOL_VERSION}".`);
  if (!['ISSUES_FOUND', 'NO_MATERIAL_ISSUES'].includes(report.status)) errors.push('status must be ISSUES_FOUND or NO_MATERIAL_ISSUES.');
  if (typeof report.summary !== 'string') errors.push('summary must be a string.');
  if (!Array.isArray(report.findings)) {
    errors.push('findings must be an array.');
    return { errors };
  }

  const updated = new Map(); // id -> new record
  const created = [];
  const downgrades = [];
  const openIds = [];
  const referenced = new Set();
  const refs = new Set();
  let n = nextFindingNumber;

  report.findings.forEach((entry, i) => {
    const where = `findings[${i}]`;
    if (!isPlainObject(entry)) return errors.push(`${where} must be an object.`);
    const hasId = 'existing_finding_id' in entry;
    const hasRef = 'provider_finding_ref' in entry;
    if (hasId === hasRef) {
      return errors.push(`${where}: must match exactly one alternative (existing_finding_id reference or provider_finding_ref candidate).`);
    }

    if (hasId) {
      // ---- Existing-finding reference (§3.3) ----
      for (const k of Object.keys(entry)) {
        if (k === 'category' || k === 'description') errors.push(`${where}: ${k} is immutable and must not appear on an existing reference.`);
        else if (!EXISTING_KEYS.includes(k)) errors.push(`${where}: unexpected field "${k}".`);
      }
      const id = entry.existing_finding_id;
      if (typeof id !== 'string' || !FINDING_ID_RE.test(id) || !findings.has(id)) {
        return errors.push(`${where}: unknown or malformed existing_finding_id "${id}".`);
      }
      if (referenced.has(id)) return errors.push(`${where}: ${id} appears more than once.`);
      referenced.add(id);
      if (![FS.OPEN, FS.RESOLVED, FS.REOPENED].includes(entry.status)) {
        return errors.push(`${where}: status must be OPEN, RESOLVED or REOPENED.`);
      }
      checkTypes(entry, where, errors);

      const prev = findings.get(id);
      const severityChanged = 'severity' in entry && entry.severity !== prev.severity;
      if (severityChanged && !('material' in entry)) {
        errors.push(`${where}: severity changed for ${id} without an explicit material value.`);
      }
      const next = {
        ...prev,
        severity: entry.severity ?? prev.severity,
        material: 'material' in entry ? entry.material : prev.material,
        materiality_justification: 'materiality_justification' in entry
          ? entry.materiality_justification : prev.materiality_justification,
        suggestion: entry.suggestion ?? prev.suggestion,
        status: prev.status === FS.RESOLVED && isOpen(entry.status) ? FS.REOPENED : entry.status,
      };
      errors.push(...materialityErrors(next, `${where} (${id})`));

      const isDowngrade = prev.material === true && isOpen(prev.status) &&
        next.material === false && isOpen(next.status);
      if (isDowngrade) {
        if (nonWhitespaceLength(entry.severity_change_reason) < MIN_JUSTIFICATION_CHARS) {
          errors.push(`${where}: downgrading material finding ${id} to non-material requires severity_change_reason of at least ${MIN_JUSTIFICATION_CHARS} non-whitespace characters.`);
        } else {
          downgrades.push({ finding_id: id, from: prev.severity, to: next.severity, reason: entry.severity_change_reason });
        }
      }
      const changes = {};
      for (const k of ['status', 'severity', 'material', 'materiality_justification', 'suggestion']) {
        if (next[k] !== prev[k]) changes[k] = { from: prev[k], to: next[k] };
      }
      if (entry.severity_change_reason) changes.severity_change_reason = entry.severity_change_reason;
      next.history = [...(prev.history || []), { cycleId, changes }];
      if (prev.cycleId !== cycleId && isOpen(next.status)) next.carriedInto = [...(prev.carriedInto || []), cycleId];
      updated.set(id, next);
      if (isOpen(next.status)) openIds.push(id);
      return undefined;
    }

    // ---- New finding candidate (§3.2) ----
    for (const k of Object.keys(entry)) if (!CANDIDATE_KEYS.includes(k)) errors.push(`${where}: unexpected field "${k}".`);
    const ref = entry.provider_finding_ref;
    if (typeof ref !== 'string' || !ref.trim()) return errors.push(`${where}: provider_finding_ref must be a non-empty string.`);
    if (refs.has(ref)) return errors.push(`${where}: duplicate provider_finding_ref "${ref}".`);
    refs.add(ref);
    if (entry.status !== FS.OPEN) errors.push(`${where}: a new candidate must have status OPEN.`);
    if (!SEVERITIES.includes(entry.severity)) errors.push(`${where}: invalid severity.`);
    if (!Categories.includes(entry.category)) errors.push(`${where}: category must be one of ${Categories.join(', ')}.`);
    if (nonWhitespaceLength(entry.description) < 1) errors.push(`${where}: description is required.`);
    if (typeof entry.suggestion !== 'string') errors.push(`${where}: suggestion is required.`);
    if (typeof entry.material !== 'boolean') errors.push(`${where}: material is required and must be boolean.`);
    checkTypes(entry, where, errors);
    errors.push(...materialityErrors(entry, where));

    const id = formatFindingId(n++);
    created.push({
      id,
      cycleId,
      providerFindingRef: ref,
      severity: entry.severity,
      category: entry.category,
      description: entry.description,
      suggestion: entry.suggestion,
      status: FS.OPEN,
      material: entry.material,
      materiality_justification: entry.materiality_justification ?? null,
      history: [{ cycleId, changes: { created: true } }],
    });
    openIds.push(id);
    return undefined;
  });

  // §3.6 consecutive-report omission check
  const omitted = prevOpenIds.filter((id) => !referenced.has(id));
  if (omitted.length) errors.push(`Omitted previously open finding(s) without an explicit status: ${omitted.join(', ')}.`);

  if (errors.length) return { errors };

  const all = new Map([...updated, ...created.map((f) => [f.id, f])]);
  const materialOpen = openIds.filter((id) => all.get(id).material === true);
  const complete = materialOpen.length === 0;
  // Downgrades only matter for the label if the downgraded finding is still open (non-material).
  const effectiveDowngrades = downgrades.filter((d) => openIds.includes(d.finding_id));

  return {
    errors: [],
    result: {
      created,
      updated: [...updated.values()],
      openIds,
      materialOpenIds: materialOpen,
      complete,
      statusMismatch: (report.status === 'NO_MATERIAL_ISSUES') !== complete, // §3.7: logged, not fatal
      downgrades: effectiveDowngrades,
      nextFindingNumber: n,
    },
  };
}
