// §3.8–§3.10 strict parsing and the G message validators. Pure functions.
// Reviewer reports are validated in findings.js because they need finding state.
import { PROTOCOL_VERSION, Decision } from './constants.js';
import { isPlainObject, nonWhitespaceLength } from './util.js';

export class ProtocolError extends Error {
  constructor(errors) {
    super(`Invalid protocol response: ${errors.join('; ')}`);
    this.name = 'ProtocolError';
    this.errors = errors;
  }
}

/**
 * FR-029: the whole response must be one JSON object. No fence stripping, no extraction of
 * an embedded object, no repair of truncated JSON. Surrounding whitespace is the only leniency.
 */
export function parseStrictJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return { errors: ['Response is empty.'] };
  let value;
  try {
    value = JSON.parse(text.trim());
  } catch (e) {
    return { errors: [`Response is not a single valid JSON document (${e.message}).`] };
  }
  if (!isPlainObject(value)) return { errors: ['Top-level JSON value must be an object.'] };
  return { value, errors: [] };
}

function checkKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unexpected field "${k}".`);
}

function checkVersion(obj, errors) {
  if (obj.protocol_version !== PROTOCOL_VERSION) {
    errors.push(`protocol_version must be "${PROTOCOL_VERSION}".`);
  }
}

// The model never supplies assets; the adapter attaches them (§3.9). An empty array is tolerated.
function checkModelAssets(obj, errors) {
  if ('assets' in obj && !(Array.isArray(obj.assets) && obj.assets.length === 0)) {
    errors.push('assets must be omitted or empty; PeerMind attaches asset descriptors itself.');
  }
}

/** §3.9 initial Generator response. */
export function validateInitialG(obj) {
  const errors = [];
  checkKeys(obj, ['protocol_version', 'summary', 'response', 'assets'], 'root', errors);
  checkVersion(obj, errors);
  if (typeof obj.summary !== 'string') errors.push('summary must be a string.');
  if (typeof obj.response !== 'string') errors.push('response must be a string.');
  checkModelAssets(obj, errors);
  return errors;
}

/**
 * §3.8 Generator refinement report. `openIds` are the OPEN/REOPENED finding IDs of the
 * immediately preceding R report (FR-022): exactly one decision each, none for anything else.
 */
export function validateRefinement(obj, openIds) {
  const errors = [];
  checkKeys(obj, ['protocol_version', 'summary', 'decisions', 'response', 'assets'], 'root', errors);
  checkVersion(obj, errors);
  if (typeof obj.summary !== 'string') errors.push('summary must be a string.');
  if (typeof obj.response !== 'string') errors.push('response must be a string.');
  checkModelAssets(obj, errors);
  if (!Array.isArray(obj.decisions)) {
    errors.push('decisions must be an array.');
    return errors;
  }
  const expected = new Set(openIds);
  const seen = new Set();
  obj.decisions.forEach((d, i) => {
    const where = `decisions[${i}]`;
    if (!isPlainObject(d)) return errors.push(`${where} must be an object.`);
    checkKeys(d, ['finding_id', 'decision', 'reason'], where, errors);
    if (!expected.has(d.finding_id)) {
      errors.push(`${where}: finding_id "${d.finding_id}" is not an open finding in the latest review.`);
    } else if (seen.has(d.finding_id)) {
      errors.push(`${where}: duplicate decision for ${d.finding_id}.`);
    }
    seen.add(d.finding_id);
    if (!Decision.includes(d.decision)) errors.push(`${where}: decision must be one of ${Decision.join(', ')}.`);
    if (nonWhitespaceLength(d.reason) < 1) errors.push(`${where}: reason is required.`);
  });
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) errors.push(`Missing decisions for: ${missing.join(', ')}.`);
  return errors;
}
