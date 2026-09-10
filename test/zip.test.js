import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import yazl from 'yazl';
import { createZipStream } from '../src/server/zip.js';

const CENTRAL_HEADER = 0x02014b50;
const END_HEADER = 0x06054b50;
const ZIP64_END_HEADER = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function readZip(bytes) {
  const endOffset = bytes.lastIndexOf(Buffer.from('PK\x05\x06', 'binary'));
  assert.notEqual(endOffset, -1, 'missing ZIP end record');
  assert.equal(bytes.readUInt32LE(endOffset), END_HEADER);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  let offset = bytes.readUInt32LE(endOffset + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index++) {
    assert.equal(bytes.readUInt32LE(offset), CENTRAL_HEADER);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString((flags & 0x800) === 0 ? 'latin1' : 'utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, { method, bytes: bytes.subarray(dataOffset, dataOffset + compressedSize) });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return {
    names: [...entries.keys()],
    entry(name) {
      const entry = entries.get(name);
      assert.ok(entry, `missing ZIP entry ${name}`);
      return entry;
    },
  };
}

function findCentralEntry(bytes, expectedName) {
  for (let offset = 0; offset <= bytes.length - 46; offset++) {
    if (bytes.readUInt32LE(offset) !== CENTRAL_HEADER) continue;
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name !== expectedName) continue;
    return {
      versionNeeded: bytes.readUInt16LE(offset + 6),
      compressedSize: bytes.readUInt32LE(offset + 20),
      uncompressedSize: bytes.readUInt32LE(offset + 24),
      extra: bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength),
    };
  }
  assert.fail(`missing central ZIP entry ${expectedName}`);
}

function findExtraField(extra, expectedId) {
  for (let offset = 0; offset <= extra.length - 4;) {
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    if (id === expectedId) return extra.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
  }
  assert.fail(`missing ZIP extra field ${expectedId}`);
}

function findRecord(bytes, signature) {
  const marker = Buffer.alloc(4);
  marker.writeUInt32LE(signature);
  const offset = bytes.lastIndexOf(marker);
  assert.notEqual(offset, -1, `missing ZIP record ${signature.toString(16)}`);
  return offset;
}

class SyntheticLargeReadable extends Readable {
  constructor(size) {
    super();
    this.size = size;
  }

  _read() {}

  pipe(crcWatcher) {
    crcWatcher.pipe = uncompressedCounter => {
      uncompressedCounter.byteCount = this.size;
      uncompressedCounter.pipe = compressor => {
        compressor.pipe = compressedCounter => {
          compressedCounter.byteCount = this.size;
          compressedCounter.pipe = output => {
            queueMicrotask(() => compressedCounter.emit('end'));
            return output;
          };
          return compressedCounter;
        };
        return compressor;
      };
      return uncompressedCounter;
    };
    return crcWatcher;
  }
}

test('ZIP stream contains store-only files and empty folders', async () => {
  const bytes = await collect(createZipStream([
    { kind: 'folder', path: 'empty/' },
    { kind: 'file', path: 'nested/file.txt', size: 5, open: () => Readable.from([Buffer.from('hello')]) },
  ]));
  const archive = readZip(bytes);
  assert.deepEqual(archive.names, ['empty/', 'nested/file.txt']);
  assert.equal(archive.entry('empty/').method, 0);
  assert.equal(archive.entry('nested/file.txt').method, 0);
  assert.equal(archive.entry('nested/file.txt').bytes.toString(), 'hello');
});

test('ZIP stream preserves Unicode paths and zero-byte files', async () => {
  const bytes = await collect(createZipStream([
    { kind: 'folder', path: 'စာများ/' },
    { kind: 'file', path: 'စာများ/日本語.txt', size: 0, open: () => Readable.from([]) },
  ]));
  const archive = readZip(bytes);
  assert.deepEqual(archive.names, ['စာများ/', 'စာများ/日本語.txt']);
  assert.equal(archive.entry('စာများ/日本語.txt').bytes.length, 0);
});

test('ZIP stream accepts an async iterable file source', async () => {
  async function* source() {
    yield Buffer.from('async');
    yield Buffer.from(' data');
  }
  const bytes = await collect(createZipStream([
    { kind: 'file', path: 'iterable.txt', size: 10, open: source },
  ]));
  assert.equal(readZip(bytes).entry('iterable.txt').bytes.toString(), 'async data');
});

test('ZIP stream propagates source errors', async () => {
  const failure = new Error('decryption failed');
  const source = new Readable({
    read() {
      this.destroy(failure);
    },
  });
  const zip = createZipStream([
    { kind: 'file', path: 'broken.txt', size: 1, open: () => source },
  ]);
  await assert.rejects(collect(zip), failure);
});

test('ZIP stream propagates writer errors', async () => {
  const zip = createZipStream([
    { kind: 'file', path: 'short.txt', size: 2, open: () => Readable.from([Buffer.from('x')]) },
  ]);
  await assert.rejects(collect(zip), /unexpected number of bytes/);
});

test('cancelling the ZIP destroys the active reader without opening later files', async () => {
  let startReading;
  const started = new Promise(resolve => {
    startReading = resolve;
  });
  const source = new Readable({
    read() {
      startReading();
    },
  });
  let laterOpenCount = 0;
  const zip = createZipStream([
    { kind: 'file', path: 'active.bin', size: 1, open: () => source },
    { kind: 'file', path: 'later.bin', size: 0, open: () => {
      laterOpenCount++;
      return Readable.from([]);
    } },
  ]);
  zip.resume();
  await started;
  zip.destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(source.destroyed, true);
  assert.equal(laterOpenCount, 0);
});

test('invalid later paths are rejected before an earlier reader is opened', () => {
  let openCount = 0;
  assert.throws(() => createZipStream([
    { kind: 'file', path: 'first.bin', size: 1, open: () => {
      openCount++;
      return Readable.from([Buffer.from('x')]);
    } },
    { kind: 'file', path: '../escape.bin', size: 0, open: () => Readable.from([]) },
  ]), /path/i);
  assert.equal(openCount, 0);
});

test('invalid entry contracts are rejected before any reader is opened', () => {
  const invalidEntries = [
    { kind: 'link', path: 'link', size: 0, open: () => Readable.from([]) },
    { kind: 'file', path: '/absolute.bin', size: 0, open: () => Readable.from([]) },
    { kind: 'file', path: 'negative.bin', size: -1, open: () => Readable.from([]) },
    { kind: 'file', path: 'missing-open.bin', size: 0 },
  ];
  for (const invalidEntry of invalidEntries) {
    let openCount = 0;
    assert.throws(() => createZipStream([
      { kind: 'file', path: 'first.bin', size: 0, open: () => {
        openCount++;
        return Readable.from([]);
      } },
      invalidEntry,
    ]));
    assert.equal(openCount, 0);
  }
});

test('synchronous writer construction failure destroys opened readers and output', () => {
  const OriginalZipFile = yazl.ZipFile;
  let createdZip;
  let addCount = 0;
  const source = new Readable({ read() {} });
  class ThrowingZipFile extends OriginalZipFile {
    constructor() {
      super();
      createdZip = this;
    }

    addReadStreamLazy(...args) {
      addCount++;
      if (addCount === 2) throw new Error('synthetic construction failure');
      return super.addReadStreamLazy(...args);
    }
  }
  yazl.ZipFile = ThrowingZipFile;
  try {
    assert.throws(() => createZipStream([
      { kind: 'file', path: 'first.bin', size: 1, open: () => source },
      { kind: 'file', path: 'second.bin', size: 0, open: () => Readable.from([]) },
    ]), /synthetic construction failure/);
    assert.equal(source.destroyed, true);
    assert.equal(createdZip.outputStream.destroyed, true);
  } finally {
    yazl.ZipFile = OriginalZipFile;
    source.destroy();
  }
});

test('a stalled ZIP consumer applies backpressure to its source', async () => {
  const chunkSize = 64 * 1024;
  const totalSize = 16 * 1024 * 1024;
  let produced = 0;
  const source = new Readable({
    read() {
      if (produced === totalSize) {
        this.push(null);
        return;
      }
      produced += chunkSize;
      this.push(Buffer.alloc(chunkSize, 0x61));
    },
  });
  const zip = createZipStream([
    { kind: 'file', path: 'large.bin', size: totalSize, open: () => source },
  ]);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(produced > 0);
  assert.ok(produced < totalSize, `source produced all ${produced} bytes without a ZIP consumer`);
  zip.destroy();
  await new Promise(resolve => zip.once('close', resolve));
  assert.equal(source.destroyed, true);
});

test('ZIP stream emits ZIP64 metadata for a synthetic file larger than 4 GiB', async () => {
  const size = 0x1_0000_0000 + 1;
  const bytes = await collect(createZipStream([
    { kind: 'file', path: 'huge.bin', size, open: () => new SyntheticLargeReadable(size) },
  ]));
  const entry = findCentralEntry(bytes, 'huge.bin');
  assert.equal(entry.versionNeeded, 45);
  assert.equal(entry.compressedSize, 0xffffffff);
  assert.equal(entry.uncompressedSize, 0xffffffff);
  const zip64 = findExtraField(entry.extra, 0x0001);
  assert.equal(zip64.readBigUInt64LE(0), BigInt(size));
  assert.equal(zip64.readBigUInt64LE(8), BigInt(size));
  const zip64EndOffset = findRecord(bytes, ZIP64_END_HEADER);
  const locatorOffset = findRecord(bytes, ZIP64_LOCATOR);
  assert.ok(zip64EndOffset < locatorOffset);
  assert.equal(bytes.readBigUInt64LE(zip64EndOffset + 24), 1n);
  assert.equal(bytes.readBigUInt64LE(zip64EndOffset + 32), 1n);
  assert.equal(bytes.readUInt32LE(locatorOffset + 16), 1);
});

test('ZIP64 entry metadata starts above the 32-bit size limit', async () => {
  const belowBoundary = 0xffff_fffe;
  const boundary = 0xffff_ffff;
  const belowBytes = await collect(createZipStream([
    { kind: 'file', path: 'below.bin', size: belowBoundary, open: () => new SyntheticLargeReadable(belowBoundary) },
  ]));
  const belowEntry = findCentralEntry(belowBytes, 'below.bin');
  assert.equal(belowEntry.versionNeeded, 20);
  assert.equal(belowEntry.compressedSize, belowBoundary);
  assert.equal(belowEntry.uncompressedSize, belowBoundary);

  const boundaryBytes = await collect(createZipStream([
    { kind: 'file', path: 'boundary.bin', size: boundary, open: () => new SyntheticLargeReadable(boundary) },
  ]));
  const boundaryEntry = findCentralEntry(boundaryBytes, 'boundary.bin');
  assert.equal(boundaryEntry.versionNeeded, 45);
  assert.equal(boundaryEntry.compressedSize, 0xffffffff);
  assert.equal(boundaryEntry.uncompressedSize, 0xffffffff);
  const zip64 = findExtraField(boundaryEntry.extra, 0x0001);
  assert.equal(zip64.readBigUInt64LE(0), BigInt(boundary));
  assert.equal(zip64.readBigUInt64LE(8), BigInt(boundary));
});
