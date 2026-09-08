import { randomBytes, scrypt, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { promisify } from 'node:util';
import { HEADER_VERSION, KDF } from './format.js';
const scryptAsync = promisify(scrypt);
export async function deriveKey(password, salt) {
  if (salt.length !== 32) throw new Error('Invalid salt');
  return scryptAsync(password, salt, 32, KDF);
}
export function derivePasskeyKey(prfOutput, salt, vaultId, credentialId) {
  if (!Buffer.isBuffer(prfOutput) || prfOutput.length !== 32) throw new Error('Invalid WebAuthn PRF output');
  if (!Buffer.isBuffer(salt) || salt.length !== 32) throw new Error('Invalid passkey PRF salt');
  if (typeof vaultId !== 'string' || typeof credentialId !== 'string') throw new Error('Invalid passkey context');
  const info = Buffer.from(JSON.stringify(['secretcli-passkey-wrap', HEADER_VERSION, vaultId, credentialId]));
  const input = Buffer.from(prfOutput);
  try { return Buffer.from(hkdfSync('sha256', input, salt, info, 32)); }
  finally { input.fill(0); }
}
export function encrypt(key, plain, context, nonce) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(context);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}
export function decrypt(key, record, context, nonce) {
  if (record.length < 16) throw new Error('Corrupt encrypted record');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(context);
  decipher.setAuthTag(record.subarray(-16));
  const plain = decipher.update(record.subarray(0, -16));
  try { decipher.final(); return plain; }
  catch { plain.fill(0); throw new Error('Corrupt data: authentication failed'); }
}
export function seal(key, plain, context) {
  const nonce = randomBytes(12);
  return Buffer.concat([nonce, encrypt(key, plain, context, nonce)]);
}
export function open(key, record, context) {
  if (record.length < 28) throw new Error('Corrupt encrypted record');
  return decrypt(key, record.subarray(12), context, record.subarray(0,12));
}
