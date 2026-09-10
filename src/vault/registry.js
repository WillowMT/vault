import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, basename, dirname } from 'node:path';
import { readLimited, writeAtomic } from './atomic.js';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_BYTES = 64 * 1024;

export function emptyRegistry() {
  return { version: 1, vaults: [] };
}

export function sanitizeName(value) {
  const cleaned = value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return NAME_PATTERN.test(cleaned) ? cleaned : 'vault';
}

export function uniqueName(registry, desired) {
  const taken = new Set(registry.vaults.map(entry => entry.name));
  if (!taken.has(desired)) return desired;
  for (let index = 2; ; index++) {
    const suffix = `-${index}`, candidate = `${desired.slice(0, 32 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function validEntry(entry) {
  return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.name === 'string' && NAME_PATTERN.test(entry.name)
    && typeof entry.path === 'string' && isAbsolute(entry.path));
}

export async function loadRegistry(path) {
  let bytes;
  try {
    bytes = await readLimited(path, MAX_BYTES);
  } catch (error) {
    if (error.code === 'ENOENT') return { registry: emptyRegistry() };
    return { registry: emptyRegistry(), warning: `The vault list at ${path} could not be read and was ignored.` };
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.vaults)) throw new Error('invalid registry');
  } catch {
    return { registry: emptyRegistry(), warning: `The vault list at ${path} uses an unsupported version or could not be read and was ignored.` };
  }
  const vaults = [], dropped = [], seenNames = new Set(), seenPaths = new Set();
  for (const entry of parsed.vaults) {
    if (!validEntry(entry)) { dropped.push(String(entry?.name ?? 'unnamed')); continue; }
    const name = entry.name, path = resolve(entry.path);
    if (seenNames.has(name) || seenPaths.has(path)) { dropped.push(name); continue; }
    seenNames.add(name); seenPaths.add(path);
    vaults.push(Number.isFinite(entry.lastOpenedAt) ? { name, path, lastOpenedAt: entry.lastOpenedAt } : { name, path });
  }
  const registry = { version: 1, vaults };
  return dropped.length
    ? { registry, warning: `${dropped.length} invalid vault list ${dropped.length === 1 ? 'entry was' : 'entries were'} removed.` }
    : { registry };
}

export async function saveRegistry(path, registry) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeAtomic(path, Buffer.from(`${JSON.stringify(registry, null, 1)}\n`, 'utf8'));
}

async function acquireRegistryLock(path) {
  const lock = `${path}.lock`, ownerPath = `${lock}/owner.json`, token = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  async function make() {
    await mkdir(lock, { mode: 0o700 });
    await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
  }
  try { await make(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse((await readLimited(ownerPath, 1024)).toString('utf8')); }
    catch { throw new Error('Vault list update lock is incomplete. Remove it after confirming no Vault command is running.'); }
    try { process.kill(previous.pid, 0);throw new Error('Another Vault command is updating the vault list.'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    await rm(lock, { recursive: true });
    await make();
  }
  return async () => {
    let owner;
    try { owner = JSON.parse((await readLimited(ownerPath, 1024)).toString('utf8')); }
    catch { return; }
    if (owner.token === token) await rm(lock, { recursive: true });
  };
}

export async function updateRegistry(path, change) {
  const release = await acquireRegistryLock(path);
  try {
    const loaded = await loadRegistry(path);
    if (loaded.warning) throw new Error(`${loaded.warning} Repair or remove it before changing the vault list.`);
    const result = await change(loaded.registry);
    await saveRegistry(path, result.registry);
    return result;
  } finally { await release(); }
}

export async function registerVault(registry, path, name) {
  const target = resolve(path);
  if (!isAbsolute(path)) throw new Error('Vault locations must be absolute paths');
  if (name !== undefined && !NAME_PATTERN.test(name)) throw new Error('Vault names use lowercase letters, digits, and dashes (max 32).');
  const desired = name ? name : sanitizeName(basename(target));
  if (name !== undefined && registry.vaults.some(entry => entry.name === desired)) throw new Error(`The name “${desired}” is already in use.`);
  if (registry.vaults.some(entry => entry.path === target)) throw new Error(`The vault at ${target} is already registered`);
  const entry = { name: uniqueName(registry, desired), path: target };
  return { registry: { version: 1, vaults: [...registry.vaults, entry] }, entry };
}

export function resolveReference(registry, reference) {
  if (typeof reference !== 'string') return undefined;
  return registry.vaults.find(entry => entry.name === reference);
}

export function touchVault(registry, path) {
  const target = resolve(path);
  return { ...registry, vaults: registry.vaults.map(entry => entry.path === target ? { ...entry, lastOpenedAt: Date.now() } : entry) };
}

export function forgetVault(registry, name) {
  const remaining = registry.vaults.filter(entry => entry.name !== name);
  if (remaining.length === registry.vaults.length) throw new Error(`Vault “${name}” is not registered`);
  return { version: 1, vaults: remaining };
}
