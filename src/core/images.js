// Image byte checks. Pure functions, shared by the service worker and tests.
import { IMPORT_LIMITS } from './constants.js';

/** Largest stored image, matching the import limit per asset (§9.6). */
export const MAX_ASSET_BYTES = IMPORT_LIMITS.eachAsset;

/**
 * Media type from the file signature (magic bytes), or null when it is not a supported image.
 * The bytes decide — never a provider's or file name's claim.
 */
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'image/gif';
  return null;
}
