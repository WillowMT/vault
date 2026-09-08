import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deriveKey, seal, open } from '../src/vault/crypto.js';

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
