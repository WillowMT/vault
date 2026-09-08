export const DATA_VERSION = 1;
export const LEGACY_HEADER_VERSION = 1;
export const HEADER_VERSION = 2;
// Kept for existing data-format consumers. New code should use DATA_VERSION.
export const VERSION = 1;
export const CHUNK = 1024 * 1024;
export const MAX_FILE = 2 ** 40;
export const MAX_CATALOG = 32 * 1024 * 1024;
export const MAX_HEADER = 64 * 1024;
export const KDF = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
export const aad = (...values) => Buffer.from(JSON.stringify(values));
export class VaultError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'VaultError'; this.status = status; }
}
