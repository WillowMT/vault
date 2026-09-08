import { mkdir, rename, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { deriveKey, seal, open } from './crypto.js';
import { aad, VERSION, KDF, MAX_CATALOG, VaultError } from './format.js';
import { assertDirectory, readLimited, writeAtomic, syncDirectory } from './atomic.js';
import { acquireLock } from './lock.js';

function context(header) { return aad('secretcli-envelope',header.version,header.vaultId,header.salt,header.kdf); }
export async function createCatalog(path, password) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  // Never replace an existing target, even if it appears empty.
  const staging = `${path}.setup-${randomUUID()}`;
  await mkdir(staging,{mode:0o700});
  try {
    const salt=randomBytes(32), key=randomBytes(32);
    const header={version:VERSION,vaultId:randomUUID(),salt:salt.toString('base64'),kdf:KDF};
    const wrapping=await deriveKey(password,salt);
    header.wrapped=seal(wrapping,key,context(header)).toString('base64'); wrapping.fill(0);
    await mkdir(join(staging,'objects'),{mode:0o700});
    await writeAtomic(join(staging,'vault.json'),Buffer.from(JSON.stringify(header)));
    await writeAtomic(join(staging,'catalog.enc'),seal(key,Buffer.from('[]'),aad('secretcli-catalog',VERSION,header.vaultId)));
    key.fill(0);
    // Reserve destination to avoid replacing a concurrently created vault.
    await mkdir(path,{mode:0o700});
    try {
      for(const name of ['objects','vault.json','catalog.enc']) await rename(join(staging,name),join(path,name));
      await syncDirectory(path); await syncDirectory(dirname(path));
    } catch(error) { throw new Error('Vault setup was interrupted; keep this directory for recovery.',{cause:error}); }
  } finally { await rm(staging,{recursive:true,force:true}); }
  return loadCatalog(path,password);
}
export async function loadCatalog(path,password) {
  await assertDirectory(path);
  const release=await acquireLock(path);
  let key;
  try {
    await assertDirectory(join(path,'objects'));
    const header=JSON.parse((await readLimited(join(path,'vault.json'),4096)).toString());
    if(header.version!==VERSION || typeof header.vaultId!=='string' || header.vaultId.length>64 || JSON.stringify(header.kdf)!==JSON.stringify(KDF)) throw new Error('Unsupported vault format');
    const wrapping=await deriveKey(password,Buffer.from(header.salt,'base64'));
    try { key=open(wrapping,Buffer.from(header.wrapped,'base64'),context(header)); }
    catch { throw new VaultError('Could not unlock. Check your password; the vault header may also be damaged.',401); }
    finally { wrapping.fill(0); }
    if(key.length!==32) throw new Error('Invalid vault key');
    const plain=open(key,await readLimited(join(path,'catalog.enc'),MAX_CATALOG+28),aad('secretcli-catalog',VERSION,header.vaultId));
    let entries;
    try { entries=JSON.parse(plain.toString()); } finally { plain.fill(0); }
    if(!Array.isArray(entries)) throw new Error('Corrupt catalog');
    let closed=false;
    return {vaultId:header.vaultId,entries,
      async save(next) {
        if(closed) throw new Error('Vault is locked');
        const plain=Buffer.from(JSON.stringify(next));
        try {
          if(plain.length>MAX_CATALOG) throw new VaultError('Vault catalog capacity reached',413);
          await writeAtomic(join(path,'catalog.enc'),seal(key,plain,aad('secretcli-catalog',VERSION,header.vaultId)));
        } finally {plain.fill(0);}
      },
      async close(){if(closed)return; closed=true; entries.length=0;key.fill(0);await release();}
    };
  } catch(error){key?.fill(0);await release();throw error;}
}
