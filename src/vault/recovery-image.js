import { randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const MAX_IMAGE_SIZE = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const RECOVERY_MAGIC = Buffer.from('VAULTKEY');
const RECOVERY_VERSION = 1;
const RECOVERY_DATA_LENGTH = 8 + 1 + 16 + 32;
const IMAGE_SIZE = 64;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function parseVaultId(vaultId) {
  if (typeof vaultId !== 'string' || !UUID_PATTERN.test(vaultId)) throw new Error('Invalid vault ID');
  return Buffer.from(vaultId.replaceAll('-', ''), 'hex');
}

function makeChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function createArtwork() {
  const rows = Buffer.alloc((IMAGE_SIZE * 3 + 1) * IMAGE_SIZE);
  for (let y = 0; y < IMAGE_SIZE; y += 1) {
    const row = y * (IMAGE_SIZE * 3 + 1);
    for (let x = 0; x < IMAGE_SIZE; x += 1) {
      const pixel = row + 1 + x * 3;
      const inVault = x >= 12 && x < 52 && y >= 16 && y < 54;
      const inDoor = x >= 18 && x < 46 && y >= 23 && y < 54;
      const color = inDoor ? [42, 57, 66] : inVault ? [204, 151, 77] : [242, 235, 220];
      rows[pixel] = color[0];
      rows[pixel + 1] = color[1];
      rows[pixel + 2] = color[2];
    }
  }
  return rows;
}

const IHDR_DATA = Buffer.alloc(13);
IHDR_DATA.writeUInt32BE(IMAGE_SIZE, 0);
IHDR_DATA.writeUInt32BE(IMAGE_SIZE, 4);
IHDR_DATA.set([8, 2, 0, 0, 0], 8);
const ARTWORK_DATA = createArtwork();
const IDAT_DATA = deflateSync(ARTWORK_DATA, { level: 9 });

export function createRecoveryImage(vaultId) {
  const vaultIdBytes = parseVaultId(vaultId);
  const secret = randomBytes(32);
  const recoveryData = Buffer.concat([
    RECOVERY_MAGIC,
    Buffer.from([RECOVERY_VERSION]),
    vaultIdBytes,
    secret
  ]);
  const recoveryChunk = makeChunk('vaUl', recoveryData);
  try {
    const image = Buffer.concat([
      PNG_SIGNATURE,
      makeChunk('IHDR', IHDR_DATA),
      makeChunk('IDAT', IDAT_DATA),
      recoveryChunk,
      makeChunk('IEND', Buffer.alloc(0))
    ]);
    return { image, secret };
  } finally {
    recoveryData.fill(0);
    recoveryChunk.fill(0);
  }
}

export function readRecoveryImage(image, expectedVaultId) {
  const expectedVaultIdBytes = parseVaultId(expectedVaultId);
  if (!Buffer.isBuffer(image) || image.length > MAX_IMAGE_SIZE || image.length < PNG_SIGNATURE.length) {
    throw new Error('Invalid recovery image');
  }
  if (!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('Invalid recovery image');

  const expectedTypes = ['IHDR', 'IDAT', 'vaUl', 'IEND'];
  let offset = PNG_SIGNATURE.length;
  let recoveryData;
  for (const expectedType of expectedTypes) {
    if (offset + 12 > image.length) throw new Error('Invalid recovery image');
    const length = image.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > image.length) throw new Error('Invalid recovery image');
    const typeBytes = image.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    const data = image.subarray(offset + 8, offset + 8 + length);
    const storedCrc = image.readUInt32BE(offset + 8 + length);
    if (type !== expectedType || crc32(image.subarray(offset + 4, offset + 8 + length)) !== storedCrc) {
      throw new Error('Invalid recovery image');
    }
    if (type === 'IHDR' && !data.equals(IHDR_DATA)) throw new Error('Invalid recovery image');
    if (type === 'IDAT') {
      let artwork;
      try {
        artwork = inflateSync(data, { maxOutputLength: ARTWORK_DATA.length });
      } catch {
        throw new Error('Invalid recovery image');
      }
      if (!artwork.equals(ARTWORK_DATA)) throw new Error('Invalid recovery image');
    }
    if (type === 'vaUl') recoveryData = data;
    if (type === 'IEND' && length !== 0) throw new Error('Invalid recovery image');
    offset = end;
  }
  if (offset !== image.length || recoveryData.length !== RECOVERY_DATA_LENGTH) {
    throw new Error('Invalid recovery image');
  }
  if (!recoveryData.subarray(0, 8).equals(RECOVERY_MAGIC) || recoveryData[8] !== RECOVERY_VERSION) {
    throw new Error('Invalid recovery image');
  }
  if (!recoveryData.subarray(9, 25).equals(expectedVaultIdBytes)) {
    throw new Error('Recovery image belongs to a different vault');
  }
  return Buffer.from(recoveryData.subarray(25));
}
