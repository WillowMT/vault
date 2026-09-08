import test from 'node:test';
import assert from 'node:assert/strict';
import { hkdfSync, randomBytes } from 'node:crypto';
import { deriveKey, derivePasskeyKey, seal, open } from '../src/vault/crypto.js';
import { DATA_VERSION, HEADER_VERSION, LEGACY_HEADER_VERSION, VERSION } from '../src/vault/format.js';

test('header and encrypted-data versions have explicit stable values', () => {
  assert.equal(LEGACY_HEADER_VERSION, 1);
  assert.equal(HEADER_VERSION, 2);
  assert.equal(DATA_VERSION, 1);
  assert.equal(VERSION, 1);
});

test('authenticated records reject tampering, wrong keys, contexts, and truncation', () => {
  const key = randomBytes(32), aad = Buffer.from('catalog:v1');
  const record = seal(key, Buffer.from('private name'), aad);
  assert.equal(open(key, record, aad).toString(), 'private name');
  assert.throws(() => open(randomBytes(32), record, aad));
  assert.throws(() => open(key, record, Buffer.from('another context')));
  assert.throws(() => open(key, record.subarray(0, 20), aad));
  record[12] ^= 1;
  assert.throws(() => open(key, record, aad));
});
test('password derivation is repeatable and salt-specific', async () => {
  const salt = randomBytes(32), password = Buffer.from('a long test passphrase');
  const a = await deriveKey(password, salt);
  assert.deepEqual(a, await deriveKey(password, salt));
  assert.notDeepEqual(a, await deriveKey(password, randomBytes(32)));
});

test('passkey derivation uses HKDF-SHA-256 with vault and credential context', () => {
  const prfOutput = randomBytes(32);
  const salt = randomBytes(32);
  const vaultId = '2a03f29a-cc4d-45a6-a1db-d98c2b614524';
  const credentialId = 'credential-id';
  const info = Buffer.from(JSON.stringify(['secretcli-passkey-wrap', 2, vaultId, credentialId]));
  const expected = Buffer.from(hkdfSync('sha256', prfOutput, salt, info, 32));

  const actual = derivePasskeyKey(prfOutput, salt, vaultId, credentialId);

  assert.deepEqual(actual, expected);
  assert.notDeepEqual(actual, derivePasskeyKey(prfOutput, salt, vaultId, 'another-credential'));
  assert.throws(() => derivePasskeyKey(randomBytes(31), salt, vaultId, credentialId), /PRF output/i);
  assert.throws(() => derivePasskeyKey(prfOutput, randomBytes(31), vaultId, credentialId), /salt/i);
});
