import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants, deflateSync, inflateSync } from 'node:zlib';
import { createRecoveryImage, readRecoveryImage } from '../src/vault/recovery-image.js';

const PNG_SIGNATURE_LENGTH = 8;
const IMAGE_SIZE = 64;

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunks(image) {
  const result = [];
  let offset = PNG_SIGNATURE_LENGTH;
  while (offset < image.length) {
    const length = image.readUInt32BE(offset);
    const end = offset + 12 + length;
    result.push({
      type: image.subarray(offset + 4, offset + 8).toString('ascii'),
      start: offset,
      end
    });
    offset = end;
  }
  return result;
}

function duplicateKeyChunk(image) {
  const parsed = chunks(image);
  const keyChunk = parsed.find(({ type }) => type === 'vaUl');
  const iend = parsed.find(({ type }) => type === 'IEND');
  return Buffer.concat([
    image.subarray(0, iend.start),
    image.subarray(keyChunk.start, keyChunk.end),
    image.subarray(iend.start)
  ]);
}

function replaceChunkData(image, type, data) {
  const parsed = chunks(image);
  const chunk = parsed.find((candidate) => candidate.type === type);
  const replacement = Buffer.alloc(12 + data.length);
  replacement.writeUInt32BE(data.length, 0);
  replacement.write(type, 4, 4, 'ascii');
  data.copy(replacement, 8);
  replacement.writeUInt32BE(crc32(replacement.subarray(4, -4)), replacement.length - 4);
  return Buffer.concat([image.subarray(0, chunk.start), replacement, image.subarray(chunk.end)]);
}

function expectedArtwork() {
  const rows = Buffer.alloc((IMAGE_SIZE * 3 + 1) * IMAGE_SIZE);
  for (let y = 0; y < IMAGE_SIZE; y += 1) {
    const row = y * (IMAGE_SIZE * 3 + 1);
    for (let x = 0; x < IMAGE_SIZE; x += 1) {
      const pixel = row + 1 + x * 3;
      const inVault = x >= 12 && x < 52 && y >= 16 && y < 54;
      const inDoor = x >= 18 && x < 46 && y >= 23 && y < 54;
      const color = inDoor ? [42, 57, 66] : inVault ? [204, 151, 77] : [242, 235, 220];
      rows.set(color, pixel);
    }
  }
  return rows;
}

test('generated recovery PNG carries one vault-bound secret', () => {
  const vaultId = randomUUID();
  const { image, secret } = createRecoveryImage(vaultId);

  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  assert.ok(image.length <= 2 * 1024 * 1024);
  assert.deepEqual(chunks(image).map(({ type }) => type), ['IHDR', 'IDAT', 'vaUl', 'IEND']);
  assert.equal(secret.length, 32);
  assert.deepEqual(readRecoveryImage(image, vaultId), secret);
  assert.throws(() => readRecoveryImage(image, randomUUID()), /different vault/i);
});

test('generated recovery PNG contains independently decodable artwork', () => {
  const { image } = createRecoveryImage(randomUUID());
  const idat = chunks(image).find(({ type }) => type === 'IDAT');
  const compressed = image.subarray(idat.start + 8, idat.end - 4);

  assert.deepEqual(inflateSync(compressed), expectedArtwork());
});

test('recovery PNG accepts equivalent artwork with different DEFLATE bytes', () => {
  const vaultId = randomUUID();
  const { image, secret } = createRecoveryImage(vaultId);
  const compressed = deflateSync(expectedArtwork(), { level: 1, strategy: constants.Z_HUFFMAN_ONLY });
  const recompressed = replaceChunkData(image, 'IDAT', compressed);

  assert.deepEqual(readRecoveryImage(recompressed, vaultId), secret);
});

test('read recovery PNG returns a copy of its secret', () => {
  const vaultId = randomUUID();
  const { image, secret } = createRecoveryImage(vaultId);
  const recovered = readRecoveryImage(image, vaultId);

  recovered.fill(0);

  assert.deepEqual(readRecoveryImage(image, vaultId), secret);
});

test('recovery image APIs preserve caller-owned buffers', () => {
  const vaultId = randomUUID();
  const { image, secret } = createRecoveryImage(vaultId);
  const originalImage = Buffer.from(image);
  const originalSecret = Buffer.from(secret);

  secret.fill(0);
  assert.deepEqual(readRecoveryImage(image, vaultId), originalSecret);
  assert.deepEqual(image, originalImage);
});

test('recovery PNG rejects corruption and duplicate key chunks', () => {
  const vaultId = randomUUID();
  const { image } = createRecoveryImage(vaultId);
  const changed = Buffer.from(image);
  changed[chunks(changed).find(({ type }) => type === 'vaUl').start + 12] ^= 1;

  assert.throws(() => readRecoveryImage(changed, vaultId), /invalid recovery image/i);
  assert.throws(() => readRecoveryImage(duplicateKeyChunk(image), vaultId), /invalid recovery image/i);
});

test('recovery PNG rejects malformed, oversized, and trailing data', () => {
  const vaultId = randomUUID();
  const { image } = createRecoveryImage(vaultId);
  const malformedLength = Buffer.from(image);
  malformedLength.writeUInt32BE(0xffffffff, PNG_SIGNATURE_LENGTH);

  assert.throws(() => readRecoveryImage(image.subarray(0, -1), vaultId), /invalid recovery image/i);
  assert.throws(() => readRecoveryImage(malformedLength, vaultId), /invalid recovery image/i);
  assert.throws(() => readRecoveryImage(Buffer.concat([image, Buffer.from([0])]), vaultId), /invalid recovery image/i);
  assert.throws(() => readRecoveryImage(Buffer.alloc(2 * 1024 * 1024 + 1), vaultId), /invalid recovery image/i);
});

test('recovery PNG rejects invalid CRCs for every chunk', () => {
  const vaultId = randomUUID();
  const { image } = createRecoveryImage(vaultId);

  for (const chunk of chunks(image)) {
    const changed = Buffer.from(image);
    changed[chunk.end - 1] ^= 1;
    assert.throws(() => readRecoveryImage(changed, vaultId), /invalid recovery image/i, chunk.type);
  }
});

test('recovery PNG rejects missing, reordered, and malformed chunks', () => {
  const vaultId = randomUUID();
  const { image } = createRecoveryImage(vaultId);
  const parsed = chunks(image);
  const ihdr = parsed.find(({ type }) => type === 'IHDR');
  const idat = parsed.find(({ type }) => type === 'IDAT');
  const key = parsed.find(({ type }) => type === 'vaUl');
  const iend = parsed.find(({ type }) => type === 'IEND');
  const withoutKey = Buffer.concat([image.subarray(0, key.start), image.subarray(key.end)]);
  const reordered = Buffer.concat([
    image.subarray(0, ihdr.end),
    image.subarray(key.start, key.end),
    image.subarray(idat.start, idat.end),
    image.subarray(iend.start)
  ]);
  const invalidIhdr = Buffer.from(image.subarray(ihdr.start + 8, ihdr.end - 4));
  invalidIhdr.writeUInt32BE(63, 0);

  assert.throws(() => readRecoveryImage(withoutKey, vaultId), /invalid recovery image/i);
  assert.throws(() => readRecoveryImage(reordered, vaultId), /invalid recovery image/i);
  assert.throws(() => readRecoveryImage(replaceChunkData(image, 'IHDR', invalidIhdr), vaultId), /invalid recovery image/i);
  assert.throws(() => readRecoveryImage(replaceChunkData(image, 'IDAT', Buffer.from('invalid deflate')), vaultId), /invalid recovery image/i);
  assert.throws(() => readRecoveryImage(replaceChunkData(image, 'IEND', Buffer.from([0])), vaultId), /invalid recovery image/i);
});

test('recovery PNG rejects invalid embedded magic and version', () => {
  const vaultId = randomUUID();
  const { image } = createRecoveryImage(vaultId);
  const key = chunks(image).find(({ type }) => type === 'vaUl');
  const data = Buffer.from(image.subarray(key.start + 8, key.end - 4));
  const invalidMagic = Buffer.from(data);
  const invalidVersion = Buffer.from(data);
  invalidMagic[0] ^= 1;
  invalidVersion[8] += 1;

  assert.throws(() => readRecoveryImage(replaceChunkData(image, 'vaUl', invalidMagic), vaultId), /invalid recovery image/i);
  assert.throws(() => readRecoveryImage(replaceChunkData(image, 'vaUl', invalidVersion), vaultId), /invalid recovery image/i);
});

test('recovery PNG validates its input and embedded format', () => {
  const vaultId = randomUUID();
  const { image } = createRecoveryImage(vaultId);

  assert.throws(() => createRecoveryImage('not-a-uuid'), /vault id/i);
  assert.throws(() => readRecoveryImage('not-a-buffer', vaultId), /invalid recovery image/i);
  assert.throws(() => readRecoveryImage(image, 'not-a-uuid'), /vault id/i);
});
