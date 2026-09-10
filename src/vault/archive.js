import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, readdir, mkdir, rename, rm, readFile, link, unlink, statfs } from 'node:fs/promises';
import { join, dirname, resolve, basename, relative, sep } from 'node:path';
import { assertDirectory, readLimited, syncDirectory } from './atomic.js';
import { acquireLock } from './lock.js';
import { DATA_VERSION, MAX_CATALOG, MAX_FILE, MAX_HEADER, VaultError } from './format.js';

const BLOCK = 512;
const CHUNK = 1024 * 1024;
const MAX_MANIFEST = MAX_CATALOG;
const MAX_CATALOG_CIPHERTEXT = MAX_CATALOG + 28;
const MAX_OBJECT_CIPHERTEXT = MAX_FILE + Math.ceil(MAX_FILE / CHUNK) * 16;
const USTAR_MAX_SIZE = parseInt('77777777777', 8);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corrupt(detail) { return new VaultError(`Archive is corrupt: ${detail}`); }

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function octal(value, digits) { return value.toString(8).padStart(digits, '0') + '\0'; }

function tarHeader(name, size, type = '0') {
  if (!Number.isSafeInteger(size) || size < 0 || size > USTAR_MAX_SIZE) throw new VaultError('Tar entry size is outside the ustar range');
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, Math.min(name.length, 99), 'utf8');
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(octal(size, 11), 124);
  block.write(octal(Math.floor(Date.now() / 1000), 11), 136);
  block.write('        ', 148);
  block.write(type, 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(octal(checksum, 6), 148);
  block[155] = 0x20;
  return block;
}

function paxRecord(key, value) {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 2;
  for (;;) {
    const next = Buffer.byteLength(payload) + String(length).length + 1;
    if (next === length) return Buffer.from(`${length} ${payload}`);
    length = next;
  }
}

function parsePaxSize(bytes) {
  let offset = 0, size;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) throw corrupt('malformed pax header');
    const length = Number(bytes.toString('ascii', offset, space));
    if (!Number.isSafeInteger(length) || length < 4 || offset + length > bytes.length) throw corrupt('malformed pax header');
    const record = bytes.toString('utf8', space + 1, offset + length);
    if (!record.endsWith('\n')) throw corrupt('malformed pax header');
    const separator = record.indexOf('=');
    if (separator < 1) throw corrupt('malformed pax header');
    if (record.slice(0, separator) === 'size') size = Number(record.slice(separator + 1, -1));
    offset += length;
  }
  if (!Number.isSafeInteger(size) || size < 0) throw corrupt('invalid pax size');
  return size;
}

async function writeTarHeader(handle, name, size) {
  if (size <= USTAR_MAX_SIZE) { await handle.write(tarHeader(name, size)); return; }
  const pax = paxRecord('size', size);
  await handle.write(tarHeader(`PaxHeaders/${basename(name)}`, pax.length, 'x'));
  await handle.write(pax);
  const padding = (BLOCK - pax.length % BLOCK) % BLOCK;
  if (padding) await handle.write(Buffer.alloc(padding));
  await handle.write(tarHeader(name, 0));
}

async function readFull(handle, buffer) {
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total);
    if (bytesRead === 0) throw corrupt('unexpected end of archive');
    total += bytesRead;
  }
}

async function hashFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK);
      if (bytesRead === 0) return { size, sha256: hash.digest('hex') };
      size += bytesRead;
      hash.update(bytesRead === CHUNK ? buffer : buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
}

async function scanArchive(handle, onEntry) {
  const header = Buffer.alloc(BLOCK);
  let paxSize;
  for (;;) {
    await readFull(handle, header);
    if (header.every(byte => byte === 0)) {
      await readFull(handle, header);
      if (!header.every(byte => byte === 0)) throw corrupt('malformed archive terminator');
      return;
    }
    let checksum = 0;
    for (let index = 0; index < BLOCK; index++) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    const stored = parseInt(header.toString('utf8', 148, 156).replace(/\0/g, ' ').trim(), 8);
    if (!Number.isSafeInteger(stored) || stored !== checksum) throw corrupt('checksum');
    const name = header.toString('utf8', 0, 156).replace(/\0[\s\S]*$/, '');
    const headerSize = parseInt(header.toString('utf8', 124, 136).replace(/\0/g, '').trim(), 8);
    const type = header.toString('utf8', 156, 157);
    if (!Number.isSafeInteger(headerSize) || headerSize < 0 || !['0', '\0', 'x'].includes(type)) throw corrupt(`entry ${name}`);
    if (type === 'x') {
      if (headerSize > 1024) throw corrupt('oversized pax header');
      const bytes = Buffer.alloc(headerSize);
      await readFull(handle, bytes);
      paxSize = parsePaxSize(bytes);
      const padding = (BLOCK - headerSize % BLOCK) % BLOCK;
      if (padding) await readFull(handle, Buffer.alloc(padding));
      continue;
    }
    const size = paxSize ?? headerSize;
    paxSize = undefined;
    await onEntry(name, size, handle);
    const padding = (BLOCK - size % BLOCK) % BLOCK;
    if (padding) {
      const skipped = Buffer.alloc(padding);
      await readFull(handle, skipped);
    }
  }
}

async function streamEntry(handle, size, { sink, hash }) {
  const buffer = Buffer.allocUnsafe(Math.min(CHUNK, size));
  let total = 0;
  while (total < size) {
    const want = Math.min(CHUNK, size - total);
    let read = 0;
    while (read < want) {
      const { bytesRead } = await handle.read(buffer, read, want - read);
      if (bytesRead === 0) throw corrupt('unexpected end of archive');
      read += bytesRead;
    }
    const bytes = buffer.subarray(0, want);
    hash?.update(bytes);
    if (sink) await sink.write(bytes);
    total += want;
  }
  return total;
}

function supportedHeader(header) {
  return Boolean(header && typeof header === 'object'
    && (header.version === 1 || header.version === 2)
    && typeof header.vaultId === 'string'
    && (header.version === 1 || header.dataVersion === DATA_VERSION));
}

export async function exportVault({ directory, output }) {
  const source = resolve(directory);
  const destination = resolve(output), relation = relative(source, destination);
  await assertDirectory(source);
  if (relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..')) throw new VaultError('Export the archive outside the vault directory.');
  if (await exists(join(source, '.recovery'))) throw new VaultError('This vault needs manual lock recovery before it can be exported. See README.');
  const release = await acquireLock(source);
  try { return await exportLockedVault(source, destination); }
  finally { await release(); }
}

async function exportLockedVault(source, output) {
  if (await exists(output)) throw new VaultError(`${output} already exists`);
  let header;
  try { header = JSON.parse((await readLimited(join(source, 'vault.json'), MAX_HEADER)).toString('utf8')); }
  catch { throw new VaultError('This directory is not a Vault vault (missing or unreadable vault.json).'); }
  if (!supportedHeader(header)) throw new VaultError('This vault uses a newer Vault format. Update Vault and try again.');
  const objects = (await readdir(join(source, 'objects'))).filter(name => !name.endsWith('.partial')).sort();
  for (const name of objects) {
    if (!UUID_PATTERN.test(name)) throw new VaultError(`Unexpected file in vault objects: ${name}`);
    const info = await lstat(join(source, 'objects', name));
    if (!info.isFile()) throw new VaultError(`Unexpected non-file entry in vault objects: ${name}`);
  }
  const files = [{ path: 'vault.json' }, { path: 'catalog.enc' }, ...objects.map(name => ({ path: `objects/${name}` }))];
  for (const file of files) Object.assign(file, await hashFile(join(source, file.path)));
  const manifest = {
    format: 1, vaultId: header.vaultId, headerVersion: header.version,
    dataVersion: header.dataVersion ?? DATA_VERSION, exportedAt: new Date().toISOString(), files
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`, 'utf8');
  const partial = `${output}.${randomUUID()}.partial`;
  let handle, published = false;
  try {
    handle = await open(partial, 'wx', 0o600);
    await handle.write(tarHeader('manifest.json', manifestBytes.length));
    await handle.write(manifestBytes);
    const padding = (BLOCK - manifestBytes.length % BLOCK) % BLOCK;
    if (padding) await handle.write(Buffer.alloc(padding));
    for (const file of files) {
      await writeTarHeader(handle, file.path, file.size);
      const input = await open(join(source, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK);
        let total = 0;
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, CHUNK);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(0, bytesRead));
          await handle.write(buffer.subarray(0, bytesRead));
          total += bytesRead;
        }
        if (total !== file.size) throw new VaultError(`Vault file changed during export: ${file.path}`);
        if (hash.digest('hex') !== file.sha256) throw new VaultError(`Vault file changed during export: ${file.path}`);
      } finally { await input.close(); }
      const gap = (BLOCK - file.size % BLOCK) % BLOCK;
      if (gap) await handle.write(Buffer.alloc(gap));
    }
    await handle.write(Buffer.alloc(2 * BLOCK));
    await handle.sync();
    await handle.close(); handle = null;
    const check = await open(partial, 'r');
    try {
      const seen = [];
      await scanArchive(check, async (name, size, archive) => {
        if (name === 'manifest.json') { await streamEntry(archive, size, { sink: null, hash: null }); return; }
        const hash = createHash('sha256');
        await streamEntry(archive, size, { hash });
        seen.push({ name, size, sha256: hash.digest('hex') });
      });
      const expected = files.map(file => ({ name: file.path, size: file.size, sha256: file.sha256 }));
      if (JSON.stringify(seen) !== JSON.stringify(expected)) throw corrupt('written archive failed verification');
    } finally { await check.close(); }
    try { await link(partial, output);published = true; }
    catch (error) { if (error.code === 'EEXIST') throw new VaultError(`${output} already exists`); throw error; }
    await unlink(partial);
    await syncDirectory(dirname(resolve(output)));
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(partial, { force: true });
    if(published){await unlink(output).catch(()=>{});await syncDirectory(dirname(output)).catch(()=>{});}
    throw error;
  }
  const info = await lstat(output);
  return { manifest, bytes: info.size };
}

function validEntryPath(path) {
  return path === 'vault.json' || path === 'catalog.enc' || (path.startsWith('objects/') && UUID_PATTERN.test(path.slice(8)));
}

function maxEntrySize(path) {
  if (path === 'vault.json') return MAX_HEADER;
  if (path === 'catalog.enc') return MAX_CATALOG_CIPHERTEXT;
  return MAX_OBJECT_CIPHERTEXT;
}

export async function importVault({ archive, directory }) {
  const target = resolve(directory);
  if (await exists(target)) throw new VaultError(`${target} already exists`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new VaultError(`${target} already exists`); throw error; }
  const staging = target, stagedHeader = join(target, '.vault.json.importing');
  let handle;
  let manifest = null;
  const remaining = new Map();
  try {
    handle = await open(archive, 'r');
    try {
      await scanArchive(handle, async (name, size, source) => {
        if (manifest === null) {
          if (name !== 'manifest.json') throw corrupt('archive must start with manifest.json');
          if (size > MAX_MANIFEST) throw corrupt('manifest too large');
          const body = Buffer.alloc(size);
          let total = 0;
          while (total < size) {
            const { bytesRead } = await source.read(body, total, size - total);
            if (bytesRead === 0) throw corrupt('unexpected end of archive');
            total += bytesRead;
          }
          let parsed;
          try { parsed = JSON.parse(body.toString('utf8')); } catch { throw corrupt('manifest.json is not valid JSON'); }
          if (!parsed || typeof parsed !== 'object' || parsed.format !== 1 || !UUID_PATTERN.test(parsed.vaultId) || !Array.isArray(parsed.files)) throw corrupt('unsupported manifest');
          if (parsed.headerVersion !== 1 && parsed.headerVersion !== 2) throw new VaultError('This archive uses a newer Vault format. Update Vault and try again.');
          if (parsed.dataVersion !== DATA_VERSION) throw new VaultError('This archive uses a newer Vault data format. Update Vault and try again.');
          let declaredBytes = 0n;
          for (const file of parsed.files) {
            if (!file || typeof file !== 'object' || !validEntryPath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxEntrySize(file.path) || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw corrupt('manifest file list');
            if (remaining.has(file.path)) throw corrupt('duplicate manifest entry');
            remaining.set(file.path, file);declaredBytes += BigInt(file.size);
          }
          if (!remaining.has('vault.json') || !remaining.has('catalog.enc')) throw corrupt('manifest is missing required vault files');
          const storage = await statfs(dirname(target));
          if (declaredBytes > BigInt(storage.bavail) * BigInt(storage.bsize)) throw new VaultError('Not enough free disk space to import this vault.');
          manifest = parsed;
          return;
        }
        const expected = remaining.get(name);
        if (!expected) throw new VaultError(`Archive contains an unexpected entry: ${name}`);
        remaining.delete(name);
        if (expected.size !== size) throw corrupt(`size mismatch for ${name}`);
        const destination = name === 'vault.json' ? stagedHeader : join(staging, name);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const hash = createHash('sha256');
        const out = await open(destination, 'wx', 0o600);
        try { await streamEntry(source, size, { sink: out, hash }); await out.sync(); }
        finally { await out.close(); }
        if (hash.digest('hex') !== expected.sha256) throw new VaultError(`Archive is corrupt: ${name} failed its checksum`);
      });
    } finally { await handle.close();handle = null; }
    if (!manifest) throw corrupt('empty archive');
    if (remaining.size) throw corrupt(`archive is missing ${remaining.size} file(s) listed in the manifest`);
    await mkdir(join(staging, 'objects'), { recursive: true, mode: 0o700 });
    let header;
    try { header = JSON.parse((await readFile(stagedHeader)).toString('utf8')); }
    catch { throw new VaultError('Archive does not contain a readable vault.json.'); }
    if (!supportedHeader(header)) throw new VaultError('This archive uses a newer Vault format. Update Vault and try again.');
    if (header.vaultId !== manifest.vaultId || header.version !== manifest.headerVersion || (header.dataVersion ?? DATA_VERSION) !== manifest.dataVersion) throw new VaultError('Archive manifest identity does not match vault.json.');
    if (!await exists(join(staging, 'catalog.enc'))) throw corrupt('archive is missing catalog.enc');
    await rename(stagedHeader, join(target, 'vault.json'));
    await syncDirectory(target);
    await syncDirectory(dirname(target));
    return { manifest };
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
