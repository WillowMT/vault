import { mkdir, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { deriveKey, derivePasskeyKey, deriveRecoveryImageKey, seal, open } from './crypto.js';
import { aad, DATA_VERSION, LEGACY_HEADER_VERSION, PASSKEY_HEADER_VERSION, HEADER_VERSION, KDF, MAX_CATALOG, MAX_HEADER, VaultError } from './format.js';
import { assertDirectory, readLimited, writeAtomic, syncDirectory } from './atomic.js';
import { acquireLock } from './lock.js';
import { createRecoveryImage as createRecoveryPng, readRecoveryImage } from './recovery-image.js';

function v1Context(header) { return aad('secretcli-envelope', header.version, header.vaultId, header.salt, header.kdf); }
function recoveryContext(header) { return aad('secretcli-recovery-envelope', PASSKEY_HEADER_VERSION, DATA_VERSION, header.vaultId, header.recovery.salt, header.recovery.kdf); }
function passkeyWrapVersion(passkey) { return passkey.wrapVersion ?? PASSKEY_HEADER_VERSION; }
function passkeyContext(header) { return aad('secretcli-passkey-envelope', passkeyWrapVersion(header.passkey), DATA_VERSION, header.vaultId, header.passkey.credentialId, header.passkey.publicKey, header.passkey.counter, header.passkey.prfSalt); }
function recoveryImageContext(header) { return aad('secretcli-image-key-envelope', HEADER_VERSION, DATA_VERSION, header.vaultId, header.recoveryImage.salt); }

const PASSKEY_TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

function decodeBase64(value, minimumLength, name, maximumLength = minimumLength) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${name}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < minimumLength || bytes.length > maximumLength || bytes.toString('base64') !== value) throw new Error(`Invalid ${name}`);
  return bytes;
}

function decodeBase64Url(value, minimumLength, name, maximumLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${name}`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < minimumLength || bytes.length > maximumLength || bytes.toString('base64url') !== value) throw new Error(`Invalid ${name}`);
  return bytes;
}

function validatePasskey(passkey, requireWrapped) {
  if (!passkey || typeof passkey !== 'object') throw new Error('Invalid passkey metadata');
  decodeBase64Url(passkey.credentialId, 1, 'passkey credential ID', 1024);
  decodeBase64Url(passkey.publicKey, 1, 'passkey public key', 8192);
  if (!Number.isSafeInteger(passkey.counter) || passkey.counter < 0) throw new Error('Invalid passkey counter');
  if (!Array.isArray(passkey.transports) || passkey.transports.length > PASSKEY_TRANSPORTS.size || passkey.transports.some(value => !PASSKEY_TRANSPORTS.has(value)) || new Set(passkey.transports).size !== passkey.transports.length) throw new Error('Invalid passkey transports');
  decodeBase64(passkey.prfSalt, 32, 'passkey PRF salt');
  if (passkey.wrapVersion !== undefined && passkey.wrapVersion !== PASSKEY_HEADER_VERSION && passkey.wrapVersion !== HEADER_VERSION) throw new Error('Invalid passkey wrap version');
  if (requireWrapped) decodeBase64(passkey.wrapped, 60, 'wrapped passkey vault key');
}

function validateRecovery(recovery) {
  if (!recovery || typeof recovery !== 'object' || JSON.stringify(recovery.kdf) !== JSON.stringify(KDF)) throw new Error('Unsupported vault format');
  decodeBase64(recovery.salt, 32, 'recovery salt');
  decodeBase64(recovery.wrapped, 60, 'wrapped recovery vault key');
}

function validateRecoveryImage(recoveryImage) {
  if (recoveryImage === null) return;
  if (!recoveryImage || typeof recoveryImage !== 'object') throw new Error('Invalid recovery image envelope');
  decodeBase64(recoveryImage.salt, 32, 'recovery image salt');
  decodeBase64(recoveryImage.wrapped, 60, 'wrapped recovery image vault key');
}

function parseHeader(bytes) {
  let header;
  try { header = JSON.parse(bytes.toString()); } catch { throw new Error('Corrupt vault header'); }
  if (!header || typeof header !== 'object' || typeof header.vaultId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(header.vaultId)) throw new Error('Unsupported vault format');
  if (header.version === LEGACY_HEADER_VERSION) {
    if (JSON.stringify(header.kdf) !== JSON.stringify(KDF)) throw new Error('Unsupported vault format');
    decodeBase64(header.salt, 32, 'password salt');
    decodeBase64(header.wrapped, 60, 'wrapped vault key');
    return header;
  }
  if (header.version === PASSKEY_HEADER_VERSION) {
    if (header.dataVersion !== DATA_VERSION) throw new Error('Unsupported vault format');
    validateRecovery(header.recovery);
    validatePasskey(header.passkey, true);
    return header;
  }
  if (header.version === HEADER_VERSION) {
    if (header.dataVersion !== DATA_VERSION) throw new Error('Unsupported vault format');
    validateRecovery(header.recovery);
    if (header.passkey !== null) {
      validatePasskey(header.passkey, true);
      if (header.passkey.wrapVersion === undefined) throw new Error('Invalid passkey wrap version');
    }
    validateRecoveryImage(header.recoveryImage);
    return header;
  }
  throw new Error('Unsupported vault format');
}

function publicPasskey(header) {
  if (header.version === LEGACY_HEADER_VERSION || header.passkey === null) return null;
  const { credentialId, publicKey, counter, transports, prfSalt } = header.passkey;
  return { credentialId, publicKey, counter, transports: [...transports], prfSalt };
}

function unlockError() {
  return new VaultError('Could not unlock. Check your secret; the vault header may also be damaged.', 401);
}

export async function createCatalog(path, password) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Never replace an existing target, even if it appears empty.
  const staging = `${path}.setup-${randomUUID()}`;
  await mkdir(staging, { mode: 0o700 });
  try {
    const salt = randomBytes(32), key = randomBytes(32);
    try {
      const header = { version: LEGACY_HEADER_VERSION, vaultId: randomUUID(), salt: salt.toString('base64'), kdf: KDF };
      const wrapping = await deriveKey(password, salt);
      try { header.wrapped = seal(wrapping, key, v1Context(header)).toString('base64'); }
      finally { wrapping.fill(0); }
      await mkdir(join(staging, 'objects'), { mode: 0o700 });
      await writeAtomic(join(staging, 'vault.json'), Buffer.from(JSON.stringify(header)));
      await writeAtomic(join(staging, 'catalog.enc'), seal(key, Buffer.from('[]'), aad('secretcli-catalog', DATA_VERSION, header.vaultId)));
      // Reserve destination to avoid replacing a concurrently created vault.
      await mkdir(path, { mode: 0o700 });
      try {
        for (const name of ['objects', 'vault.json', 'catalog.enc']) await rename(join(staging, name), join(path, name));
        await syncDirectory(path); await syncDirectory(dirname(path));
      } catch (error) { throw new Error('Vault setup was interrupted; keep this directory for recovery.', { cause: error }); }
    } finally { salt.fill(0); key.fill(0); }
  } finally { await rm(staging, { recursive: true, force: true }); }
  return loadCatalog(path, password);
}

export async function loadCatalog(path, password) {
  const prepared = await prepareCatalog(path);
  try { return await prepared.unlockWithPassword(password); }
  catch (error) { await prepared.close(); throw error; }
}

export async function prepareCatalog(path) {
  await assertDirectory(path);
  const release = await acquireLock(path);
  try {
    await assertDirectory(join(path, 'objects'));
    let header = parseHeader(await readLimited(join(path, 'vault.json'), MAX_HEADER));
    let closed = false, closing = false, consumed = false, attempting = false, attemptDone = Promise.resolve(), finishAttempt, closePromise;
    function active() { if (closed || closing || consumed) throw new Error('Prepared vault is closed'); }
    function beginAttempt() {
      active();
      if (attempting) throw new Error('An unlock attempt is already in progress');
      attempting = true;
      attemptDone = new Promise(resolve => { finishAttempt = resolve; });
    }
    function endAttempt() { attempting = false; finishAttempt(); }

    async function readEntries(key) {
      const plain = open(key, await readLimited(join(path, 'catalog.enc'), MAX_CATALOG + 28), aad('secretcli-catalog', DATA_VERSION, header.vaultId));
      let entries;
      try { entries = JSON.parse(plain.toString()); } finally { plain.fill(0); }
      if (!Array.isArray(entries)) throw new Error('Corrupt catalog');
      return entries;
    }

    async function finish(key, recoveryWrapping) {
      if (key.length !== 32) { key.fill(0); throw new Error('Invalid vault key'); }
      let entries;
      try {
        entries = await readEntries(key);
        if (closing) throw new Error('Prepared vault is closed');
        consumed = true;
        return makeCatalog(key, entries, recoveryWrapping);
      } catch (error) { entries?.splice(0); key.fill(0); recoveryWrapping?.fill(0); throw error; }
    }

    async function unlockWithPassword(password) {
      beginAttempt();
      try {
        const recovery = header.version === LEGACY_HEADER_VERSION ? header : header.recovery;
        let wrapping = await deriveKey(password, Buffer.from(recovery.salt, 'base64'));
        let key;
        try { key = open(wrapping, Buffer.from(recovery.wrapped, 'base64'), header.version === LEGACY_HEADER_VERSION ? v1Context(header) : recoveryContext(header)); }
        catch { throw unlockError(); }
        const retained = header.version === LEGACY_HEADER_VERSION ? wrapping : undefined;
        try {
          const catalog = await finish(key, retained);
          if (retained) wrapping = undefined;
          return catalog;
        } finally { wrapping?.fill(0); }
      } finally { endAttempt(); }
    }

    async function unlockWithPasskey(prfOutput, newCounter) {
      if (!Buffer.isBuffer(prfOutput) || prfOutput.length !== 32) throw new Error('Invalid WebAuthn PRF output');
      const prf = Buffer.from(prfOutput);
      let wrapping, key, entries, started = false;
      try {
        beginAttempt();
        started = true;
        if (header.version === LEGACY_HEADER_VERSION || header.passkey === null) throw new VaultError('This vault does not have a passkey', 400);
        if (!Number.isSafeInteger(newCounter) || newCounter < header.passkey.counter) throw new VaultError('Invalid passkey counter', 401);
        const salt = Buffer.from(header.passkey.prfSalt, 'base64');
        try { wrapping = derivePasskeyKey(prf, salt, header.vaultId, header.passkey.credentialId, passkeyWrapVersion(header.passkey)); }
        finally { salt.fill(0); }
        try { key = open(wrapping, Buffer.from(header.passkey.wrapped, 'base64'), passkeyContext(header)); }
        catch { throw unlockError(); }
        if (key.length !== 32) throw new Error('Invalid vault key');
        entries = await readEntries(key);

        const next = { ...header, passkey: { ...header.passkey, counter: newCounter } };
        next.passkey.wrapped = seal(wrapping, key, passkeyContext(next)).toString('base64');
        const check = open(wrapping, Buffer.from(next.passkey.wrapped, 'base64'), passkeyContext(next));
        try { if (!timingSafeEqual(check, key)) throw new Error('Could not update passkey envelope'); }
        finally { check.fill(0); }
        await writeAtomic(join(path, 'vault.json'), Buffer.from(JSON.stringify(next)));
        header = next;
        if (closing) throw new Error('Prepared vault is closed');
        consumed = true;
        const catalog = makeCatalog(key, entries);
        key = undefined; entries = undefined;
        return catalog;
      } catch (error) {
        entries?.splice(0); key?.fill(0); throw error;
      } finally {
        wrapping?.fill(0); prf.fill(0);
        if (started) endAttempt();
      }
    }

    async function unlockWithRecoveryImage(image) {
      let secret, salt, wrapping, key;
      beginAttempt();
      try {
        if (header.version !== HEADER_VERSION || header.recoveryImage === null) throw new VaultError('This vault does not have a recovery file', 400);
        secret = readRecoveryImage(image, header.vaultId);
        salt = Buffer.from(header.recoveryImage.salt, 'base64');
        wrapping = await deriveRecoveryImageKey(secret, salt, header.vaultId);
        try { key = open(wrapping, Buffer.from(header.recoveryImage.wrapped, 'base64'), recoveryImageContext(header)); }
        catch { throw new VaultError('Could not unlock with this recovery file; it may have been replaced or damaged.', 401); }
        return await finish(key);
      } finally {
        secret?.fill(0); salt?.fill(0); wrapping?.fill(0);
        endAttempt();
      }
    }

    function makeCatalog(key, entries, legacyRecoveryWrapping) {
      let catalogClosed = false;
      function v3Header() {
        let recovery;
        if (header.version === LEGACY_HEADER_VERSION) {
          if (!legacyRecoveryWrapping) throw new Error('Password recovery is unavailable');
          recovery = { salt: header.salt, kdf: header.kdf };
          const contextHeader = { vaultId: header.vaultId, recovery };
          recovery.wrapped = seal(legacyRecoveryWrapping, key, recoveryContext(contextHeader)).toString('base64');
        } else {
          recovery = { ...header.recovery };
        }
        let passkey = null;
        if (header.version !== LEGACY_HEADER_VERSION && header.passkey !== null) {
          passkey = { ...header.passkey, transports: [...header.passkey.transports], wrapVersion: passkeyWrapVersion(header.passkey) };
        }
        return { version: HEADER_VERSION, dataVersion: DATA_VERSION, vaultId: header.vaultId, recovery, passkey,
          recoveryImage: header.version === HEADER_VERSION && header.recoveryImage ? { ...header.recoveryImage } : null };
      }

      async function commit(next) {
        await writeAtomic(join(path, 'vault.json'), Buffer.from(JSON.stringify(next)));
        header = next;
      }

      return { vaultId: header.vaultId, entries,
        async save(next) {
          if (catalogClosed) throw new Error('Vault is locked');
          const plain = Buffer.from(JSON.stringify(next));
          try {
            if (plain.length > MAX_CATALOG) throw new VaultError('Vault catalog capacity reached', 413);
            await writeAtomic(join(path, 'catalog.enc'), seal(key, plain, aad('secretcli-catalog', DATA_VERSION, header.vaultId)));
          } finally { plain.fill(0); }
        },
        async enrollPasskey(password, metadata, prfOutput) {
          if (catalogClosed) throw new Error('Vault is locked');
          validatePasskey(metadata, false);
          if (!Buffer.isBuffer(prfOutput) || prfOutput.length !== 32) throw new Error('Invalid WebAuthn PRF output');
          const prf = Buffer.from(prfOutput);
          try {
            const current = header.version === LEGACY_HEADER_VERSION ? header : header.recovery;
            const currentWrapping = await deriveKey(password, Buffer.from(current.salt, 'base64'));
            let currentKey;
            try { currentKey = open(currentWrapping, Buffer.from(current.wrapped, 'base64'), header.version === LEGACY_HEADER_VERSION ? v1Context(header) : recoveryContext(header)); }
            catch { throw unlockError(); }
            finally { currentWrapping.fill(0); }
            try {
              if (currentKey.length !== key.length || !timingSafeEqual(currentKey, key)) throw unlockError();
            } finally { currentKey.fill(0); }

            const next = { version: PASSKEY_HEADER_VERSION, dataVersion: DATA_VERSION, vaultId: header.vaultId,
              recovery: { salt: randomBytes(32).toString('base64'), kdf: KDF },
              passkey: { credentialId: metadata.credentialId, publicKey: metadata.publicKey, counter: metadata.counter, transports: [...metadata.transports], prfSalt: metadata.prfSalt }
            };
            const recoverySalt = Buffer.from(next.recovery.salt, 'base64');
            const passkeySalt = Buffer.from(next.passkey.prfSalt, 'base64');
            const recoveryWrapping = await deriveKey(password, recoverySalt);
            let passkeyWrapping;
            try {
              next.recovery.wrapped = seal(recoveryWrapping, key, recoveryContext(next)).toString('base64');
               passkeyWrapping = derivePasskeyKey(prf, passkeySalt, next.vaultId, next.passkey.credentialId, PASSKEY_HEADER_VERSION);
              next.passkey.wrapped = seal(passkeyWrapping, key, passkeyContext(next)).toString('base64');
              const recoveryCheck = open(recoveryWrapping, Buffer.from(next.recovery.wrapped, 'base64'), recoveryContext(next));
              const passkeyCheck = open(passkeyWrapping, Buffer.from(next.passkey.wrapped, 'base64'), passkeyContext(next));
              try {
                if (!timingSafeEqual(recoveryCheck, key) || !timingSafeEqual(passkeyCheck, key)) throw new Error('Could not construct vault key envelopes');
              } finally { recoveryCheck.fill(0); passkeyCheck.fill(0); }
              await writeAtomic(join(path, 'vault.json'), Buffer.from(JSON.stringify(next)));
              header = next;
             } finally { recoverySalt.fill(0); passkeySalt.fill(0); recoveryWrapping.fill(0); passkeyWrapping?.fill(0); }
           } finally { prf.fill(0); }
         },
        async createRecoveryImage() {
          if (catalogClosed) throw new Error('Vault is locked');
          const { image, secret } = createRecoveryPng(header.vaultId);
          const next = v3Header(), salt = randomBytes(32);
          let wrapping, check, committed = false;
          try {
            next.recoveryImage = { salt: salt.toString('base64') };
            wrapping = await deriveRecoveryImageKey(secret, salt, next.vaultId);
            next.recoveryImage.wrapped = seal(wrapping, key, recoveryImageContext(next)).toString('base64');
            check = open(wrapping, Buffer.from(next.recoveryImage.wrapped, 'base64'), recoveryImageContext(next));
            if (!timingSafeEqual(check, key)) throw new Error('Could not construct recovery image envelope');
            await commit(next);
            committed = true;
            return image;
          } finally {
            secret.fill(0); salt.fill(0); wrapping?.fill(0); check?.fill(0);
            if (!committed) image.fill(0);
          }
        },
        async disablePasskey() {
          if (catalogClosed) throw new Error('Vault is locked');
          const next = v3Header();
          next.passkey = null;
          await commit(next);
        },
        async setPasskey(metadata, prfOutput) {
          if (catalogClosed) throw new Error('Vault is locked');
          validatePasskey(metadata, false);
          if (!Buffer.isBuffer(prfOutput) || prfOutput.length !== 32) throw new Error('Invalid WebAuthn PRF output');
          const prf = Buffer.from(prfOutput), next = v3Header();
          next.passkey = { credentialId: metadata.credentialId, publicKey: metadata.publicKey, counter: metadata.counter,
            transports: [...metadata.transports], prfSalt: metadata.prfSalt, wrapVersion: HEADER_VERSION };
          const salt = Buffer.from(next.passkey.prfSalt, 'base64');
          let wrapping, check;
          try {
            wrapping = derivePasskeyKey(prf, salt, next.vaultId, next.passkey.credentialId, HEADER_VERSION);
            next.passkey.wrapped = seal(wrapping, key, passkeyContext(next)).toString('base64');
            check = open(wrapping, Buffer.from(next.passkey.wrapped, 'base64'), passkeyContext(next));
            if (!timingSafeEqual(check, key)) throw new Error('Could not construct passkey envelope');
            await commit(next);
          } finally { prf.fill(0); salt.fill(0); wrapping?.fill(0); check?.fill(0); }
        },
        passkeyStatus() {
          if (catalogClosed) throw new Error('Vault is locked');
          return { enabled: Boolean(header.passkey) };
        },
        async close() {
          if (catalogClosed) return;
          catalogClosed = true; entries.length = 0; key.fill(0); legacyRecoveryWrapping?.fill(0); await release();
        }
      };
    }

    return { version: header.version, vaultId: header.vaultId, passkey: publicPasskey(header), unlockWithPassword, unlockWithPasskey, unlockWithRecoveryImage,
      async close() {
        if (closed || consumed) return;
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
          await attemptDone;
          if (!consumed) { closed = true; await release(); }
        })();
        return closePromise;
      }
    };
  } catch (error) { await release(); throw error; }
}
