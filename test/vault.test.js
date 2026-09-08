import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVault, prepareVault, unlockVault } from '../src/vault/vault.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'secretcli-test-'));
  const path = join(root, 'vault');
  const password = Buffer.from('test only passphrase');
  const vault = await createVault(path, password);
  t.after(async () => { await vault.close(); await rm(root, { recursive: true, force: true }); });
  return { vault, path, password };
}
async function collect(stream) { const parts=[]; for await (const part of stream) parts.push(part); return Buffer.concat(parts); }
function passkeyMetadata() {
  return {
    credentialId: Buffer.from('test credential id').toString('base64url'),
    publicKey: Buffer.from('test public key').toString('base64url'),
    counter: 4,
    transports: ['internal', 'hybrid'],
    prfSalt: Buffer.alloc(32, 7).toString('base64')
  };
}

test('unlocked vault exposes an immutable vault ID', async t => {
  const { vault } = await fixture(t);
  const vaultId = vault.vaultId;
  assert.match(vaultId, /^[0-9a-f-]{36}$/i);
  assert.throws(() => { vault.vaultId = 'changed'; }, TypeError);
  assert.equal(vault.vaultId, vaultId);
});

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

test('bulk move validates complete selections before changing the catalog', async t => {
  const {vault}=await fixture(t);
  const source=await vault.mkdir(null,'Source'), destination=await vault.mkdir(null,'Destination');
  const one=await vault.upload(source.id,'one.txt','text/plain',[Buffer.from('one')]);
  const two=await vault.upload(source.id,'two.txt','text/plain',[Buffer.from('two')]);
  assert.equal(await vault.moveMany([one.id,two.id],destination.id),2);
  assert.deepEqual(vault.list(destination.id).map(entry=>entry.name).sort(),['one.txt','two.txt']);
  await assert.rejects(vault.moveMany([one.id,'missing'],null),/not found/i);
  assert.deepEqual(vault.list(destination.id).map(entry=>entry.name).sort(),['one.txt','two.txt']);
  await assert.rejects(vault.moveMany([],null),/non-empty/i);
  await assert.rejects(vault.moveMany([one.id,one.id],null),/unique/i);
});

test('bulk move rejects selected-name collisions and folder descendant destinations', async t => {
  const {vault}=await fixture(t);
  const left=await vault.mkdir(null,'Left'), right=await vault.mkdir(null,'Right'), destination=await vault.mkdir(null,'Destination');
  const first=await vault.upload(left.id,'same.txt','text/plain',[Buffer.from('first')]);
  const second=await vault.upload(right.id,'same.txt','text/plain',[Buffer.from('second')]);
  await assert.rejects(vault.moveMany([first.id,second.id],destination.id),/exists/i);
  assert.equal(vault.stat(first.id).parentId,left.id);
  assert.equal(vault.stat(second.id).parentId,right.id);
  const child=await vault.mkdir(left.id,'Child');
  await assert.rejects(vault.moveMany([left.id],child.id),/itself|descendant/i);
  assert.equal(vault.stat(left.id).parentId,null);
});

test('bulk delete expands overlapping folders and returns the selected count', async t => {
  const {vault}=await fixture(t);
  const parent=await vault.mkdir(null,'Parent'), child=await vault.mkdir(parent.id,'Child');
  const file=await vault.upload(child.id,'secret.txt','text/plain',[Buffer.from('secret')]);
  assert.equal(await vault.removeMany([parent.id,child.id]),2);
  assert.throws(()=>vault.stat(parent.id),/not found/i);
  assert.throws(()=>vault.stat(child.id),/not found/i);
  assert.throws(()=>vault.stat(file.id),/not found/i);
  await assert.rejects(vault.removeMany(['missing',file.id]),/not found/i);
  await assert.rejects(vault.removeMany([]),/non-empty/i);
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

test('v1 enrollment atomically adds recovery and passkey envelopes without rewriting data', async t => {
  const {vault,path,password}=await fixture(t);
  await vault.upload(null,'kept.txt','text/plain',[Buffer.from('kept')]);
  const catalogBefore=await readFile(join(path,'catalog.enc'));
  const objectName=(await readdir(join(path,'objects')))[0];
  const objectBefore=await readFile(join(path,'objects',objectName));
  const prfOutput=Buffer.alloc(32,9),metadata=passkeyMetadata();

  await vault.enrollPasskey(password,metadata,prfOutput);

  const header=JSON.parse(await readFile(join(path,'vault.json'),'utf8'));
  assert.equal(header.version,2);
  assert.equal(header.dataVersion,1);
  assert.equal(header.recovery.salt.length,44);
  assert.equal(typeof header.recovery.wrapped,'string');
  assert.equal(header.passkey.credentialId,metadata.credentialId);
  assert.equal(typeof header.passkey.wrapped,'string');
  assert.deepEqual(await readFile(join(path,'catalog.enc')),catalogBefore);
  assert.deepEqual(await readFile(join(path,'objects',objectName)),objectBefore);
});

test('prepared v2 vault preserves caller PRF buffers and permits passkey retry while retaining its lock', async t => {
  const {vault,path,password}=await fixture(t);
  const metadata=passkeyMetadata(),prfOutput=Buffer.alloc(32,11);
  await vault.mkdir(null,'private');
  await vault.enrollPasskey(password,metadata,prfOutput);
  await vault.close();

  const prepared=await prepareVault(path);
  assert.equal(prepared.version,2);
  assert.equal(prepared.vaultId.length,36);
  assert.deepEqual(prepared.passkey,metadata);
  const wrongPrf=Buffer.alloc(32,12),wrongPrfBefore=Buffer.from(wrongPrf);
  await assert.rejects(prepared.unlockWithPasskey(wrongPrf,5),/unlock|damaged/i);
  assert.deepEqual(wrongPrf,wrongPrfBefore);
  await assert.rejects(prepareVault(path),/already|open|locked/i);
  const prfBefore=Buffer.from(prfOutput);
  const reopened=await prepared.unlockWithPasskey(prfOutput,5);
  assert.deepEqual(prfOutput,prfBefore);
  try { assert.equal(reopened.list()[0].name,'private'); } finally { await reopened.close(); }
});

test('prepared v2 vault permits password retry and v1 remains supported', async t => {
  const {vault,path,password}=await fixture(t);
  const originalHeader=JSON.parse(await readFile(join(path,'vault.json'),'utf8'));
  assert.equal(originalHeader.version,1);
  await vault.close();

  const v1=await prepareVault(path);
  assert.equal(v1.version,1);
  assert.equal(v1.passkey,null);
  await assert.rejects(v1.unlockWithPassword(Buffer.from('wrong')),/password|unlock/i);
  const reopened=await v1.unlockWithPassword(password);
  await reopened.enrollPasskey(password,passkeyMetadata(),Buffer.alloc(32,13));
  await reopened.close();

  const v2=await prepareVault(path);
  await assert.rejects(v2.unlockWithPassword(Buffer.from('wrong')),/password|unlock/i);
  const recovered=await v2.unlockWithPassword(password);
  await recovered.close();
});

test('failed enrollment leaves the v1 header unchanged and usable', async t => {
  const {vault,path,password}=await fixture(t);
  const before=await readFile(join(path,'vault.json'));
  await assert.rejects(vault.enrollPasskey(Buffer.from('wrong'),passkeyMetadata(),Buffer.alloc(32,15)),/password|unlock/i);
  await assert.rejects(vault.enrollPasskey(password,{...passkeyMetadata(),prfSalt:'bad'},Buffer.alloc(32,15)),/passkey|salt|metadata/i);
  await assert.rejects(vault.enrollPasskey(password,{...passkeyMetadata(),credentialId:'not base64!'},Buffer.alloc(32,15)),/credential/i);
  await assert.rejects(vault.enrollPasskey(password,{...passkeyMetadata(),publicKey:'eA=='},Buffer.alloc(32,15)),/public key/i);
  await assert.rejects(vault.enrollPasskey(password,{...passkeyMetadata(),transports:['internal','bogus']},Buffer.alloc(32,15)),/transport/i);
  assert.deepEqual(await readFile(join(path,'vault.json')),before);
  await vault.close();
  const reopened=await unlockVault(path,password);
  await reopened.close();
});

test('prepared vault allows only one concurrent unlock attempt', async t => {
  const {vault,path,password}=await fixture(t);
  const prfOutput=Buffer.alloc(32,17);
  await vault.enrollPasskey(password,passkeyMetadata(),prfOutput);
  await vault.close();
  const prepared=await prepareVault(path);

  const results=await Promise.allSettled([
    prepared.unlockWithPasskey(prfOutput,5),
    prepared.unlockWithPasskey(prfOutput,5)
  ]);

  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected').length,1);
  for(const result of results)if(result.status==='fulfilled')await result.value.close();
});

test('malformed v2 metadata releases the lock and a modified passkey envelope fails closed', async t => {
  const {vault,path,password}=await fixture(t);
  const prfOutput=Buffer.alloc(32,19);
  await vault.enrollPasskey(password,passkeyMetadata(),prfOutput);
  await vault.close();
  const header=JSON.parse(await readFile(join(path,'vault.json'),'utf8'));
  await writeFile(join(path,'vault.json'),JSON.stringify({...header,vaultId:'not-a-uuid'}));
  await assert.rejects(prepareVault(path),/unsupported/i);
  await writeFile(join(path,'vault.json'),JSON.stringify({...header,dataVersion:2}));
  await assert.rejects(prepareVault(path),/unsupported/i);

  const wrapped=Buffer.from(header.passkey.wrapped,'base64');
  wrapped[12]^=1;
  header.passkey.wrapped=wrapped.toString('base64');
  await writeFile(join(path,'vault.json'),JSON.stringify(header));
  const prepared=await prepareVault(path);
  await assert.rejects(prepared.unlockWithPasskey(prfOutput,4),/unlock|damaged/i);
  const recovered=await prepared.unlockWithPassword(password);
  await recovered.close();
});

test('passkey unlock authenticates and atomically persists a nondecreasing counter', async t => {
  const {vault,path,password}=await fixture(t);
  const prfOutput=Buffer.alloc(32,21);
  await vault.enrollPasskey(password,passkeyMetadata(),prfOutput);
  await vault.close();
  const before=JSON.parse(await readFile(join(path,'vault.json'),'utf8'));
  const prepared=await prepareVault(path);
  await assert.rejects(prepared.unlockWithPasskey(prfOutput,3),/counter/i);
  const reopened=await prepared.unlockWithPasskey(prfOutput,9);
  await reopened.close();

  const after=JSON.parse(await readFile(join(path,'vault.json'),'utf8'));
  assert.equal(after.passkey.counter,9);
  assert.notEqual(after.passkey.wrapped,before.passkey.wrapped);
});

test('tampering with the stored passkey counter invalidates its envelope', async t => {
  const {vault,path,password}=await fixture(t);
  const prfOutput=Buffer.alloc(32,23);
  await vault.enrollPasskey(password,passkeyMetadata(),prfOutput);
  await vault.close();
  const header=JSON.parse(await readFile(join(path,'vault.json'),'utf8'));
  header.passkey.counter++;
  await writeFile(join(path,'vault.json'),JSON.stringify(header));

  const prepared=await prepareVault(path);
  await assert.rejects(prepared.unlockWithPasskey(prfOutput,header.passkey.counter),/unlock|damaged/i);
  const recovered=await prepared.unlockWithPassword(password);
  await recovered.close();
});

test('closing a prepared vault waits for and cancels an in-flight unlock', async t => {
  const {vault,path,password}=await fixture(t);
  await vault.close();
  const prepared=await prepareVault(path);
  const unlocking=prepared.unlockWithPassword(password);
  const closing=prepared.close();

  await closing;
  await assert.rejects(unlocking,/closed|locked/i);
  const next=await prepareVault(path);
  await next.close();
});

test('closing during passkey unlock releases ownership even after counter persistence', async t => {
  const {vault,path,password}=await fixture(t);
  const prfOutput=Buffer.alloc(32,25);
  await vault.enrollPasskey(password,passkeyMetadata(),prfOutput);
  await vault.close();
  const prepared=await prepareVault(path);
  const unlocking=prepared.unlockWithPasskey(prfOutput,7);

  await prepared.close();
  await assert.rejects(unlocking,/closed|locked/i);
  const next=await prepareVault(path);
  const recovered=await next.unlockWithPassword(password);
  await recovered.close();
});
