import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, readdir, mkdir, rename, rm, readFile } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { assertDirectory, readLimited, syncDirectory } from './atomic.js';
import { DATA_VERSION, MAX_HEADER, VaultError } from './format.js';

const BLOCK = 512;
const CHUNK = 1024 * 1024;
const MAX_MANIFEST = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corrupt(detail) { return new VaultError(`Archive is corrupt: ${detail}`); }

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function octal(value, digits) { return value.toString(8).padStart(digits, '0') + '\0'; }

function tarHeader(name, size) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, Math.min(name.length, 99), 'utf8');
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(octal(size, 11), 124);
  block.write(octal(Math.floor(Date.now() / 1000), 11), 136);
  block.write('        ', 148);
  block.write('0', 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(octal(checksum, 6), 148);
  return block;
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
  const handle = await open(path, 'r');
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
    const size = parseInt(header.toString('utf8', 124, 136).replace(/\0/g, '').trim(), 8);
    const type = header.toString('utf8', 156, 157);
    if (!Number.isSafeInteger(size) || size < 0 || (type !== '0' && type !== '\0')) throw corrupt(`entry ${name}`);
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

export async function exportVault({ directory, output, verify = true }) {
  const source = resolve(directory);
  await assertDirectory(source);
  if (await exists(join(source, '.lock'))) throw new VaultError('This vault is open. Quit SecretCLI (Ctrl+C), then export again.');
  if (await exists(join(source, '.recovery'))) throw new VaultError('This vault needs manual lock recovery before it can be exported. See README.');
  let header;
  try { header = JSON.parse((await readLimited(join(source, 'vault.json'), MAX_HEADER)).toString('utf8')); }
  catch { throw new VaultError('This directory is not a SecretCLI vault (missing or unreadable vault.json).'); }
  if (!supportedHeader(header)) throw new VaultError('This vault uses a newer SecretCLI format. Update SecretCLI and try again.');
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
  let handle;
  try {
    handle = await open(partial, 'wx', 0o600);
    await handle.write(tarHeader('manifest.json', manifestBytes.length));
    await handle.write(manifestBytes);
    const padding = (BLOCK - manifestBytes.length % BLOCK) % BLOCK;
    if (padding) await handle.write(Buffer.alloc(padding));
    for (const file of files) {
      await handle.write(tarHeader(file.path, file.size));
      const input = await open(join(source, file.path), 'r');
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
      } finally { await input.close(); }
      const gap = (BLOCK - file.size % BLOCK) % BLOCK;
      if (gap) await handle.write(Buffer.alloc(gap));
    }
    await handle.write(Buffer.alloc(2 * BLOCK));
    await handle.sync();
    await handle.close(); handle = null;
    if (verify) {
      const check = await open(partial, 'r');
      try {
        const seen = [];
        await scanArchive(check, async (name, size, archive) => {
          if (name === 'manifest.json') { const skip = Buffer.alloc(size); await streamEntry(archive, size, { sink: null, hash: null }); return; }
          const hash = createHash('sha256');
          await streamEntry(archive, size, { hash });
          seen.push({ name, size, sha256: hash.digest('hex') });
        });
        const expected = files.map(file => ({ name: file.path, size: file.size, sha256: file.sha256 }));
        if (JSON.stringify(seen) !== JSON.stringify(expected)) throw corrupt('written archive failed verification');
      } finally { await check.close(); }
    }
    await rename(partial, output);
    await syncDirectory(dirname(resolve(output)));
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(partial, { force: true });
    throw error;
  }
  const info = await lstat(output);
  return { manifest, bytes: info.size };
}

function validEntryPath(path) {
  return path === 'vault.json' || path === 'catalog.enc' || (path.startsWith('objects/') && UUID_PATTERN.test(path.slice(8)));
}

export async function importVault({ archive, directory }) {
  const target = resolve(directory);
  if (await exists(target)) throw new VaultError(`${target} already exists`);
  const staging = join(dirname(target), `.${basename(target)}.${randomUUID()}.importing`);
  await mkdir(staging, { mode: 0o700 });
  let handle;
  let manifest = null;
  const remaining = new Map();
  try {
    handle = await open(archive, 'r');
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
        if (!parsed || typeof parsed !== 'object' || parsed.format !== 1 || typeof parsed.vaultId !== 'string' || !Array.isArray(parsed.files)) throw corrupt('unsupported manifest');
        if (parsed.headerVersion !== 1 && parsed.headerVersion !== 2) throw new VaultError('This archive uses a newer SecretCLI format. Update SecretCLI and try again.');
        if (parsed.dataVersion !== DATA_VERSION) throw new VaultError('This archive uses a newer SecretCLI data format. Update SecretCLI and try again.');
        for (const file of parsed.files) {
          if (!file || typeof file !== 'object' || !validEntryPath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw corrupt('manifest file list');
          if (remaining.has(file.path)) throw corrupt('duplicate manifest entry');
          remaining.set(file.path, file);
        }
        manifest = parsed;
        return;
      }
      const expected = remaining.get(name);
      if (!expected) throw new VaultError(`Archive contains an unexpected entry: ${name}`);
      remaining.delete(name);
      if (expected.size !== size) throw corrupt(`size mismatch for ${name}`);
      const destination = join(staging, name);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const hash = createHash('sha256');
      const out = await open(destination, 'wx', 0o600);
      try { await streamEntry(source, size, { sink: out, hash }); await out.sync(); }
      finally { await out.close(); }
      if (hash.digest('hex') !== expected.sha256) throw new VaultError(`Archive is corrupt: ${name} failed its checksum`);
    });
    if (!manifest) throw corrupt('empty archive');
    if (remaining.size) throw corrupt(`archive is missing ${remaining.size} file(s) listed in the manifest`);
  } finally { await handle?.close(); }
  try {
    let header;
    try { header = JSON.parse((await readFile(join(staging, 'vault.json'))).toString('utf8')); }
    catch { throw new VaultError('Archive does not contain a readable vault.json.'); }
    if (!supportedHeader(header)) throw new VaultError('This archive uses a newer SecretCLI format. Update SecretCLI and try again.');
    if (!await exists(join(staging, 'catalog.enc'))) throw corrupt('archive is missing catalog.enc');
    await rename(staging, target);
    await syncDirectory(dirname(target));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { manifest };
}
