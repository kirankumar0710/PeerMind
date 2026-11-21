// §15 conversation export: conversation.json, memory.json, metadata.json and assets/.
// Credentials never appear: settings and keys are not read here, and provider metadata is non-secret.
import { createZip } from './zip.js';
import { ARCHIVE_FORMAT_VERSION, EXPORTER_VERSION } from '../core/constants.js';
import { MEDIA_EXT, nowIso } from '../core/util.js';

const SCHEMAS = {
  conversation: { name: 'peermind.conversation', version: '1.0' },
  memory: { name: 'peermind.memory', version: '1.0' },
  metadata: { name: 'peermind.metadata', version: '1.0' },
};

const assetPath = (a) => `assets/${a.asset_id}.${MEDIA_EXT[a.media_type]}`;

/** @param {object} data result of storage/db.js loadConversation() */
export function buildExportEntries(data) {
  const { conversation: c, runs, operations, messages, findings, assets } = data;
  const strip = ({ key, conversationId, ...rest }) => rest;
  const conversationJson = {
    schema: SCHEMAS.conversation.name,
    schema_version: SCHEMAS.conversation.version,
    conversation: {
      id: c.id, title: c.title, created_at: c.createdAt, updated_at: c.updatedAt,
      budget: { cap_usd: c.capUsd, enforced: c.budgetEnforced },
    },
    messages,
    runs: runs.map((r) => ({
      id: r.id, prompt_message_id: r.promptMessageId, state: r.state,
      completion_reason: r.completionReason, abandonment_reason: r.abandonmentReason,
      review_status: r.reviewStatus, review_labels: r.reviewLabels,
      final_output_reviewed: r.finalOutputReviewed, final_output_message_id: r.latestOutputMessageId,
      downgrades: r.downgrades, iteration_limit: r.config?.iterationLimit ?? null,
      refinements_done: r.cursor.refinementsDone, created_at: r.createdAt, updated_at: r.updatedAt,
    })),
    operations: operations.map(({ rawResult, ...op }) => op), // usage, cost (estimates), state and context sent
    findings: findings.map(strip),
    assets: assets.map((a) => ({
      asset_id: a.asset_id, media_type: a.media_type, operation: a.operation, source_asset_id: a.source_asset_id,
      sha256: a.sha256, byte_length: a.byte_length, relative_path: assetPath(a),
    })),
  };
  const memoryJson = { schema: SCHEMAS.memory.name, schema_version: SCHEMAS.memory.version, records: [] };
  const metadataJson = {
    schema: SCHEMAS.metadata.name, schema_version: SCHEMAS.metadata.version,
    archive_format_version: ARCHIVE_FORMAT_VERSION, exporter_version: EXPORTER_VERSION, exported_at: nowIso(),
    members: {
      'conversation.json': SCHEMAS.conversation, 'memory.json': SCHEMAS.memory, 'metadata.json': SCHEMAS.metadata,
    },
    providers: [...new Set(operations.map((o) => `${o.vendor}:${o.model}`))].map((s) => {
      const [vendor, model] = s.split(':');
      return { vendor, model };
    }),
  };
  return [
    { name: 'conversation.json', data: JSON.stringify(conversationJson, null, 2) },
    { name: 'memory.json', data: JSON.stringify(memoryJson, null, 2) },
    { name: 'metadata.json', data: JSON.stringify(metadataJson, null, 2) },
    ...assets.map((a) => ({ name: assetPath(a), data: new Uint8Array(a.bytes) })),
  ];
}

export const buildExportZip = (data) => createZip(buildExportEntries(data));
