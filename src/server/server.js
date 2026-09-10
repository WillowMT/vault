import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createPasskeyService } from '../auth/passkeys.js';
import { VaultError } from '../vault/format.js';
import { createSession } from './session.js';
import { headers, checkRequest, contentType, disposition } from './security.js';
import { parseRange } from './ranges.js';
import { restrictedPage } from './unlock.js';

const assets = new Map([
  ['/', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
  ['/api.js', 'api.js'],
  ['/preview.js', 'preview.js'],
  ['/thumbnails.js', 'thumbnails.js']
]);
const restrictedAssets = new Set(['/', '/styles.css', '/unlock.js']);

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function body(req, maximum = 16 * 1024) {
  let length = 0;
  const parts = [];
  for await (const part of req) {
    length += part.length;
    if (length > maximum) throw new VaultError('Request too large', 413);
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new VaultError('Invalid JSON request');
  }
}

function assetType(file) {
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/html; charset=utf-8';
}

function safeAuthError(status, message) {
  return new VaultError(message, status);
}

async function start({ initialVault, prepared, initialMode, recoveryPassword, passkeyService, onUnlock, onEnroll }) {
  const session = createSession();
  const sockets = new Set();
  const pending = new Set();
  let vault = initialVault;
  let mode = initialMode;
  let origin;
  let closed = false;
  let closePromise;
  let enrollmentWork;
  const password = recoveryPassword === undefined ? undefined : Buffer.from(recoveryPassword);

  const server = createServer({ requestTimeout: 0, headersTimeout: 15000, maxHeaderSize: 16384 }, (req, res) => {
    const work = handle(req, res).catch(error => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error.code === 'ENOSPC' ? 507 : (error.status || 500);
      const message = status === 500
        ? 'The operation failed. The vault may contain damaged data.'
        : status === 507 ? 'Disk is full. Free space and try again.' : error.message;
      json(res, status, { error: message });
    });
    pending.add(work);
    work.finally(() => pending.delete(work));
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  async function serveAsset(path, res) {
    if (mode !== 'ready') {
      if (!restrictedAssets.has(path)) return false;
      if (path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(restrictedPage(mode));
        return true;
      }
      if (path === '/unlock.js') {
        try {
          const data = await readFile(new URL('../../web/unlock.js', import.meta.url));
          res.writeHead(200, { 'Content-Type': assetType('unlock.js') });
          res.end(data);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          res.writeHead(204);
          res.end();
        }
        return true;
      }
    }
    if (!assets.has(path)) return false;
    const file = assets.get(path);
    const data = await readFile(new URL(`../../web/${file}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': assetType(file) });
    res.end(data);
    return true;
  }

  async function lockedPasskey(path, req, res) {
    if (mode !== 'locked' || req.method !== 'POST') return false;
    if (path === '/api/passkey/authentication/options') {
      await body(req, 64 * 1024);
      try {
        json(res, 200, await passkeys.beginAuthentication(prepared.passkey));
      } catch {
        throw safeAuthError(400, 'Could not start passkey authentication');
      }
      return true;
    }
    if (path === '/api/passkey/authentication/verify') {
      const value = await body(req, 64 * 1024);
      let result;
      try {
        result = await passkeys.verifyAuthentication(value.credential, value.prf);
      } catch {
        throw safeAuthError(401, 'Passkey authentication failed');
      }
      mode = 'unlocking';
      let opened;
      try {
        opened = await prepared.unlockWithPasskey(result.prfOutput, result.newCounter);
      } catch {
        if (!closed) mode = 'locked';
        throw safeAuthError(401, 'Passkey authentication failed');
      }
      if (closed) {
        await opened.close?.();
        throw safeAuthError(401, 'Vault is locked');
      }
      vault = opened;
      mode = 'ready';
      const authorization = session.authorize();
      await onUnlock?.(opened);
      res.setHeader('Set-Cookie', authorization.cookie);
      json(res, 200, { csrfToken: authorization.csrfToken });
      return true;
    }
    return false;
  }

  async function enrollmentPasskey(path, req, res) {
    if (mode !== 'enrollment' || req.method !== 'POST') return false;
    if (path === '/api/passkey/registration/options') {
      await body(req, 64 * 1024);
      try {
        const options = await passkeys.beginRegistration({
          userID: Buffer.from(vault.vaultId),
          userName: vault.vaultId,
          userDisplayName: 'Vault'
        });
        json(res, 200, options);
      } catch {
        throw safeAuthError(400, 'Could not start passkey enrollment');
      }
      return true;
    }
    if (path === '/api/passkey/registration/verify') {
      const value = await body(req, 64 * 1024);
      try {
        json(res, 200, await passkeys.verifyRegistration(value.credential));
      } catch {
        throw safeAuthError(400, 'Passkey enrollment failed');
      }
      return true;
    }
    if (path === '/api/passkey/registration/confirm') {
      const value = await body(req, 64 * 1024);
      const perform = (async () => {
        let result;
        try {
          result = await passkeys.verifyRegistrationConfirmation(value.credential, value.prf);
        } catch {
          throw safeAuthError(400, 'Passkey enrollment failed');
        }
        if (closed) throw safeAuthError(401, 'Vault is locked');
        const { prfOutput, newCounter: _newCounter, ...metadata } = result;
        try {
          await vault.enrollPasskey(password, metadata, prfOutput);
        } catch {
          throw safeAuthError(400, 'Passkey enrollment failed');
        }
        password.fill(0);
        if (closed) throw safeAuthError(401, 'Vault is locked');
        mode = 'ready';
        const authorization = session.authorize();
        await onEnroll?.(vault);
        res.setHeader('Set-Cookie', authorization.cookie);
        json(res, 200, { csrfToken: authorization.csrfToken });
      })();
      enrollmentWork = perform;
      try {
        await perform;
      } finally {
        if (enrollmentWork === perform) enrollmentWork = undefined;
      }
      return true;
    }
    return false;
  }

  async function handle(req, res) {
    headers(res);
    checkRequest(req, origin);
    if (closed) throw new VaultError('Vault is locked', 401);
    const url = new URL(req.url, origin);
    const path = url.pathname;
    if (req.method === 'GET' && await serveAsset(path, res)) return;
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (await lockedPasskey(path, req, res)) return;
    if (await enrollmentPasskey(path, req, res)) return;
    if (mode !== 'ready') {
      if (path.startsWith('/api/')) throw new VaultError('Vault is locked', 401);
      throw new VaultError('Not found', 404);
    }
    if (path === '/api/session' && req.method === 'POST') {
      const value = await body(req);
      const result = session.exchange(value.token);
      res.setHeader('Set-Cookie', result.cookie);
      json(res, 200, { csrfToken: result.csrfToken });
      return;
    }
    session.authenticate(req);
    if (!['GET', 'HEAD'].includes(req.method)) session.verifyCsrf(req);
    if (req.method === 'GET' && path === '/api/session') {
      json(res, 200, { csrfToken: session.csrf() });
      return;
    }
    if (req.method === 'GET' && path === '/api/heartbeat') {
      json(res, 200, { unlocked: true });
      return;
    }
    if (req.method === 'GET' && path === '/api/entries') {
      json(res, 200, {
        entries: vault.list(url.searchParams.get('parentId') || null, url.searchParams.get('q') || '', { recursive: url.searchParams.get('scope') === 'all' }),
        folders: vault.folders(),
        summary: vault.summary()
      });
      return;
    }
    if (req.method === 'POST' && path === '/api/folders') {
      const value = await body(req);
      json(res, 201, await vault.mkdir(value.parentId ?? null, value.name));
      return;
    }
    if (req.method === 'POST' && path === '/api/entries/bulk-move') {
      const value = await body(req);
      json(res, 200, { moved: await vault.moveMany(value.ids, value.parentId ?? null) });
      return;
    }
    if (req.method === 'POST' && path === '/api/entries/bulk-delete') {
      const value = await body(req);
      json(res, 200, { deleted: await vault.removeMany(value.ids) });
      return;
    }
    if (req.method === 'POST' && path === '/api/files') {
      const controller = new AbortController();
      req.on('aborted', () => controller.abort());
      req.setTimeout(60000, () => {
        controller.abort();
        req.destroy();
      });
      const entry = await vault.upload(url.searchParams.get('parentId') || null, url.searchParams.get('name'), req.headers['content-type'] || 'application/octet-stream', req, controller.signal);
      req.setTimeout(0);
      json(res, 201, entry);
      return;
    }
    const entryMatch = /^\/api\/entries\/([a-f0-9-]{36})$/.exec(path);
    if (entryMatch && req.method === 'PATCH') {
      const value = await body(req);
      if (Object.keys(value).some(key => !['name', 'parentId'].includes(key))) throw new VaultError('Invalid file update');
      json(res, 200, await vault.update(entryMatch[1], value));
      return;
    }
    if (entryMatch && req.method === 'DELETE') {
      await vault.remove(entryMatch[1]);
      json(res, 200, { deleted: true });
      return;
    }
    const fileMatch = /^\/api\/files\/([a-f0-9-]{36})\/(content|download)$/.exec(path);
    if (fileMatch && ['GET', 'HEAD'].includes(req.method)) {
      const entry = vault.stat(fileMatch[1]);
      if (entry.kind !== 'file') throw new VaultError('Not a file');
      let range;
      try {
        range = parseRange(req.headers.range, entry.size);
      } catch (error) {
        res.setHeader('Content-Range', `bytes */${entry.size}`);
        throw error;
      }
      const type = contentType(entry.mime);
      const attachment = fileMatch[2] === 'download' || type === 'application/octet-stream';
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Disposition', disposition(entry.name, attachment));
      res.setHeader('Accept-Ranges', 'bytes');
      if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${entry.size}`);
      res.setHeader('Content-Length', range ? range.end - range.start + 1 : entry.size);
      res.statusCode = range ? 206 : 200;
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      await pipeline(Readable.from(vault.read(entry.id, range?.start, range?.end)), res);
      return;
    }
    throw new VaultError('Not found', 404);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://localhost:${server.address().port}`;
  const passkeys = passkeyService ?? (mode === 'ready' ? undefined : createPasskeyService({ origin }));
  const api = {
    origin,
    launchUrl: mode === 'ready' ? '' : `${origin}/`,
    renewLaunchUrl() {
      if (mode !== 'ready') throw new Error('Vault is locked');
      return `${origin}/#${session.renew()}`;
    },
    async recover(recovery) {
      if (!prepared || mode !== 'locked' || closed) throw new VaultError('Vault is not waiting for recovery', 400);
      mode = 'unlocking';
      let opened;
      try {
        opened = await prepared.unlockWithPassword(recovery);
      } catch (error) {
        if (!closed) mode = 'locked';
        throw error;
      }
      if (closed) {
        await opened.close?.();
        throw new VaultError('Vault is locked', 401);
      }
      vault = opened;
      mode = 'ready';
      await onUnlock?.(opened);
      return api.renewLaunchUrl();
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      mode = 'closed';
      session.close();
      const ownerClose = Promise.resolve().then(() => prepared?.close());
      const activeEnrollment = enrollmentWork;
      closePromise = (async () => {
        if (!activeEnrollment) password?.fill(0);
        const stopped = new Promise(resolve => server.close(resolve));
        for (const socket of sockets) socket.destroy();
        await stopped;
        await Promise.allSettled([...pending]);
        await Promise.allSettled([ownerClose, activeEnrollment]);
        password?.fill(0);
      })();
      return closePromise;
    }
  };
  if (mode === 'ready') api.launchUrl = api.renewLaunchUrl();
  return api;
}

export function startServer(vault) {
  return start({ initialVault: vault, initialMode: 'ready' });
}

export function startLockedServer(prepared, { passkeyService, onUnlock } = {}) {
  return start({ prepared, initialMode: 'locked', passkeyService, onUnlock });
}

export function startEnrollmentServer(vault, recoveryPassword, { passkeyService, onEnroll } = {}) {
  return start({ initialVault: vault, initialMode: 'enrollment', recoveryPassword, passkeyService, onEnroll });
}
