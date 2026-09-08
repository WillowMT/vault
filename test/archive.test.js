import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,mkdir,writeFile,readFile,open,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVault,unlockVault } from '../src/vault/vault.js';
import { exportVault,importVault } from '../src/vault/archive.js';

async function collect(vault){
  const files={};
  for(const entry of await vault.list(null,'',{recursive:true})){
    if(entry.kind!=='file')continue;
    const chunks=[];
    for await(const bytes of vault.read(entry.id))chunks.push(bytes);
    files[entry.name]=Buffer.concat(chunks);
  }
  return files;
}

test('export and import round-trip a vault with multi-chunk objects',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-archive-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const vault=await createVault(join(root,'vault'),Buffer.from('archive test passphrase'));
  await vault.upload(null,'small.txt','text/plain',[Buffer.from('hello archive')]);
  await vault.upload(null,'big.bin','application/octet-stream',[Buffer.alloc(3*1048576+7,7)]);
  await vault.close();
  const archivePath=join(root,'backup.scvault');
  const summary=await exportVault({directory:join(root,'vault'),output:archivePath});
  assert.equal(summary.manifest.files.length,4);
  assert.deepEqual(summary.manifest.files.map(file=>file.path).slice(0,2),['vault.json','catalog.enc']);
  assert.equal(summary.manifest.files.filter(file=>file.path.startsWith('objects/')).length,2);
  const restored=join(root,'restored');
  await importVault({archive:archivePath,directory:restored});
  const reopened=await unlockVault(restored,Buffer.from('archive test passphrase'));
  t.after(async()=>{try{await reopened.close();}catch{}});
  const files=await collect(reopened);
  assert.equal(files['small.txt'].toString(),'hello archive');
  assert.equal(files['big.bin'].length,3*1048576+7);
  assert.equal(files['big.bin'].every(byte=>byte===7),true);
});

test('export refuses a running vault and a vault pending manual recovery',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-archive-lock-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const vault=await createVault(join(root,'vault'),Buffer.from('archive lock passphrase'));
  await assert.rejects(()=>exportVault({directory:join(root,'vault'),output:join(root,'a.scvault')}),/open/i);
  await vault.close();
  await exportVault({directory:join(root,'vault'),output:join(root,'a.scvault')});
  await mkdir(join(root,'vault','.recovery'));
  await assert.rejects(()=>exportVault({directory:join(root,'vault'),output:join(root,'b.scvault')}),/recovery/i);
});

test('export skips partial objects and import refuses an existing destination',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-archive-part-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const vault=await createVault(join(root,'vault'),Buffer.from('archive partial passphrase'));
  await vault.upload(null,'keep.txt','text/plain',[Buffer.from('kept')]);
  await vault.close();
  await writeFile(join(root,'vault','objects','x.partial'),Buffer.from('junk'));
  const archivePath=join(root,'backup.scvault');
  const {manifest}=await exportVault({directory:join(root,'vault'),output:archivePath});
  assert.equal(manifest.files.filter(file=>file.path.includes('.partial')).length,0);
  const restored=join(root,'restored');
  await importVault({archive:archivePath,directory:restored});
  await assert.rejects(()=>importVault({archive:archivePath,directory:restored}),/already exists/i);
});

test('import rejects corrupted and truncated archives without writing the destination',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-archive-corrupt-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const vault=await createVault(join(root,'vault'),Buffer.from('archive corrupt passphrase'));
  await vault.upload(null,'data.txt','text/plain',[Buffer.from('payload '.repeat(200000))]);
  await vault.close();
  const archivePath=join(root,'backup.scvault');
  await exportVault({directory:join(root,'vault'),output:archivePath});
  const bytes=await readFile(archivePath);
  const flipped=Buffer.from(bytes);flipped[flipped.length-600]^=0xff;
  const corrupted=join(root,'corrupted.scvault');await writeFile(corrupted,flipped);
  const restored=join(root,'restored');
  await assert.rejects(()=>importVault({archive:corrupted,directory:restored}),/corrupt|mismatch/i);
  await assert.rejects(()=>open(restored,'r'),/ENOENT/);
  const truncated=join(root,'truncated.scvault');await writeFile(truncated,bytes.subarray(0,bytes.length-1024));
  await assert.rejects(()=>importVault({archive:truncated,directory:restored}),/corrupt|truncated|unexpected end/i);
});

test('export rejects vault headers from a newer format version',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-archive-version-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'vault');
  await mkdir(join(directory,'objects'),{recursive:true});
  await writeFile(join(directory,'vault.json'),JSON.stringify({version:99,vaultId:'11111111-1111-4111-8111-111111111111'}));
  await writeFile(join(directory,'catalog.enc'),Buffer.from('catalog'));
  await assert.rejects(()=>exportVault({directory,output:join(root,'a.scvault')}),/newer|unsupported/i);
});
