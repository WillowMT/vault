import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVault, unlockVault } from '../src/vault/vault.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'secretcli-test-'));
  const path = join(root, 'vault');
  const password = Buffer.from('test only passphrase');
  const vault = await createVault(path, password);
  t.after(async () => { await vault.close(); await rm(root, { recursive: true, force: true }); });
  return { vault, path, password };
}
async function collect(stream) { const parts=[]; for await (const part of stream) parts.push(part); return Buffer.concat(parts); }

test('vault encrypts names and contents and survives reopening', async t => {
  const {vault,path,password} = await fixture(t);
  const folder = await vault.mkdir(null, 'private holiday');
  const input = Buffer.alloc(2 * 1048576 + 17, 83);
  const file = await vault.upload(folder.id, 'secret movie.bin', 'application/octet-stream', [input]);
  assert.deepEqual(await collect(vault.read(file.id,1048570,1048590)), input.subarray(1048570,1048591));
  assert.deepEqual(await collect(vault.read(file.id)), input);
  assert.equal(JSON.stringify(vault.list(folder.id)).includes('fileKey'), false);
  assert.equal((await readFile(join(path,'catalog.enc'))).includes('private holiday'), false);
  const object = (await readdir(join(path,'objects')))[0];
  assert.equal((await readFile(join(path,'objects',object))).includes(input.subarray(0,128)),false);
  await assert.rejects(unlockVault(path,password), /already|open|locked/i);
  await vault.close();
  await assert.rejects(unlockVault(path,Buffer.from('wrong password')), /password|unlock/i);
  const reopened = await unlockVault(path,password);
  try { assert.deepEqual(await collect(reopened.read(file.id)),input); } finally { await reopened.close(); }
});

test('folder operations validate collisions, ancestry, and names', async t => {
  const {vault} = await fixture(t);
  const a = await vault.mkdir(null,'A'), b = await vault.mkdir(a.id,'B');
  await assert.rejects(vault.mkdir(null,'A'), /exists/i);
  await assert.rejects(vault.mkdir(null,'../bad'), /name/i);
  await assert.rejects(vault.update(a.id,{parentId:b.id}), /itself|descendant/i);
  await vault.update(b.id,{parentId:null,name:'renamed'});
  assert.equal(vault.list(null,'renamed').length,1);
  const file=await vault.upload(a.id,'empty','application/octet-stream',[]);
  assert.equal((await collect(vault.read(file.id))).length,0);
  await vault.remove(a.id);
  assert.throws(()=>vault.stat(file.id),/not found/i);
});

test('corrupt, reordered, truncated, and appended objects are rejected', async t => {
  const {vault,path} = await fixture(t);
  const file=await vault.upload(null,'test.bin','application/octet-stream',[Buffer.alloc(2*1048576,9)]);
  const target=join(path,'objects',(await readdir(join(path,'objects')))[0]);
  const original=await readFile(target), stride=1048576+16;
  for (const corrupt of [Buffer.concat([original.subarray(stride),original.subarray(0,stride)]), original.subarray(0,-1), Buffer.concat([original,Buffer.from('x')])]) {
    await writeFile(target,corrupt);
    await assert.rejects(collect(vault.read(file.id)),/corrupt|auth|size/i);
  }
  const corrupt=Buffer.from(original); corrupt[123]^=1; await writeFile(target,corrupt);
  await assert.rejects(collect(vault.read(file.id)),/corrupt|auth/i);
});

test('failed uploads remain invisible and do not damage previous files', async t => {
  const {vault,path,password} = await fixture(t);
  const good=await vault.upload(null,'good.txt','text/plain',[Buffer.from('good')]);
  async function* broken(){ yield Buffer.alloc(1048576); throw new Error('interrupted'); }
  await assert.rejects(vault.upload(null,'broken.bin','application/octet-stream',broken()),/interrupted/);
  assert.equal(vault.list(null).length,1);
  await vault.close();
  const next=await unlockVault(path,password);
  try { assert.equal((await collect(next.read(good.id))).toString(),'good'); assert.equal((await readdir(join(path,'objects'))).length,1); }
  finally { await next.close(); }
});

test('recursive listing includes nested media without exposing encryption keys',async t=>{
  const {vault}=await fixture(t);const folder=await vault.mkdir(null,'Media');
  await vault.upload(folder.id,'sound.wav','audio/wav',[Buffer.from('test')]);
  const all=vault.list(null,'',{recursive:true});assert.equal(all.length,2);assert.equal(JSON.stringify(all).includes('fileKey'),false);
});
