import { Readable } from 'node:stream';
import yazl from 'yazl';

function validatePath(path, kind) {
  if (typeof path !== 'string' || path === '') throw new TypeError('ZIP entry path must be a non-empty string');
  const normalized = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) throw new Error(`ZIP entry path must be relative: ${path}`);
  if (normalized.split('/').includes('..')) throw new Error(`ZIP entry path cannot contain '..': ${path}`);
  if (kind === 'file' && normalized.endsWith('/')) throw new Error(`ZIP file path cannot end with '/': ${path}`);
  if (Buffer.byteLength(normalized) > 0xffff) throw new Error('ZIP entry path is too long');
}

function validateEntries(entries) {
  const validated = Array.from(entries);
  for (const entry of validated) {
    if (!entry || typeof entry !== 'object') throw new TypeError('ZIP entry must be an object');
    if (entry.kind !== 'file' && entry.kind !== 'folder') throw new TypeError('ZIP entry kind must be file or folder');
    validatePath(entry.path, entry.kind);
    if (entry.kind === 'file') {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new TypeError('ZIP file size must be a non-negative safe integer');
      if (typeof entry.open !== 'function') throw new TypeError('ZIP file open must be a function');
    }
  }
  return validated;
}

export function createZipStream(entries) {
  const validatedEntries = validateEntries(entries);
  const zip = new yazl.ZipFile();
  const activeReaders = new Set();
  let failed = false;
  let cancelled = false;

  function destroyReaders() {
    for (const source of activeReaders) source.destroy();
  }

  zip.on('error', error => {
    if (failed) return;
    failed = true;
    zip.outputStream.destroy(error);
  });
  zip.outputStream.on('close', () => {
    if (zip.outputStream.readableEnded) return;
    cancelled = true;
    destroyReaders();
  });

  try {
    for (const entry of validatedEntries) {
      if (entry.kind === 'folder') {
        zip.addEmptyDirectory(entry.path);
        continue;
      }
      zip.addReadStreamLazy(entry.path, {
        size: entry.size,
        compress: false,
        forceZip64Format: entry.size > 0xffffffff,
      }, callback => {
        if (cancelled) {
          callback(new Error('ZIP stream was cancelled'));
          return;
        }
        let source;
        try {
          const opened = entry.open();
          source = opened instanceof Readable ? opened : Readable.from(opened);
        } catch (error) {
          callback(error);
          return;
        }
        activeReaders.add(source);
        source.once('close', () => activeReaders.delete(source));
        source.once('error', error => zip.emit('error', error));
        callback(null, source);
      });
    }

    zip.end();
  } catch (error) {
    failed = true;
    cancelled = true;
    destroyReaders();
    zip.outputStream.destroy();
    throw error;
  }

  return zip.outputStream;
}
