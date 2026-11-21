// Small pure helpers shared by core modules.

export const nonWhitespaceLength = (s) => (typeof s === 'string' ? s.replace(/\s+/g, '').length : 0);

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const nowIso = () => new Date().toISOString();

export const uid = (prefix) => `${prefix}-${crypto.randomUUID()}`;

export const formatFindingId = (n) => `PM-F-${String(n).padStart(5, '0')}`;
export const formatAssetId = (n) => `PM-A-${String(n).padStart(4, '0')}`;
export const FINDING_ID_RE = /^PM-F-\d{5}$/;

// Rough token estimate used for context and cost estimation. Labelled as an estimate everywhere.
export const estimateTokens = (text) => Math.ceil((text || '').length / 4);

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export const MEDIA_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
