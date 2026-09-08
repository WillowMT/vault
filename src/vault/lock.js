import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertDirectory, readLimited } from './atomic.js';

export async function acquireLock(path) {
  const lock = join(path, '.lock'), marker = join(path, '.recovery');
  const ownerPath = join(lock, 'owner.json');
  const token = randomUUID();
  async function owner() { return JSON.parse((await readLimited(ownerPath, 1024)).toString()); }
  async function make() {
    await mkdir(lock, { mode: 0o700 });
    await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), { flag:'wx', mode:0o600 });
  }
  try { await make(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await assertDirectory(lock);
    let previous;
    try { previous = await owner(); } catch { throw new Error('Vault lock is incomplete. See README lock recovery instructions.'); }
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.token !== 'string') throw new Error('Vault lock is incomplete. See README.');
    try { process.kill(previous.pid, 0); throw new Error('Vault is already open in another terminal'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    try { await mkdir(marker, {mode:0o700}); } catch { throw new Error('Vault lock recovery is already in progress. See README.'); }
    try {
      const latest = await owner();
      if (latest.token !== previous.token) throw new Error('Vault is already open');
      await rm(lock, {recursive:true});
      await make();
    } finally { await rm(marker,{recursive:true,force:true}); }
  }
  let released = false;
  return async () => {
    if (released) return; released = true;
    if ((await owner()).token === token) await rm(lock, {recursive:true});
  };
}
