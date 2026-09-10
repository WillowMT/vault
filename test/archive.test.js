import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,mkdir,writeFile,readFile,open,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVault,unlockVault } from '../src/vault/vault.js';
import { acquireLock } from '../src/vault/lock.js';
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

test('an empty vault imports with its required objects directory',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-empty-archive-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const password=Buffer.from('empty archive passphrase'),source=join(root,'vault');
  const vault=await createVault(source,password);await vault.close();
  const archive=join(root,'empty.scvault'),restored=join(root,'restored');
  await exportVault({directory:source,output:archive});
  await importVault({archive,directory:restored});
  assert.deepEqual(await readdir(join(restored,'objects')),[]);
  const reopened=await unlockVault(restored,password);
  assert.deepEqual(reopened.list(),[]);
  await reopened.close();
});

test('export refuses a running vault and a vault pending manual recovery',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-archive-lock-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const vault=await createVault(join(root,'vault'),Buffer.from('archive lock passphrase'));
  await assert.rejects(()=>exportVault({directory:join(root,'vault'),output:join(root,'a.scvault')}),/open/i);
  await vault.close();
  await exportVault({directory:join(root,'vault'),output:join(root,'a.scvault')});
  await assert.rejects(()=>exportVault({directory:join(root,'vault'),output:join(root,'a.scvault')}),/already exists/i);
  await mkdir(join(root,'vault','.recovery'));
  await assert.rejects(()=>exportVault({directory:join(root,'vault'),output:join(root,'b.scvault')}),/recovery/i);
});

test('export holds the exclusive vault lock for the entire snapshot',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-archive-lock-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'vault');
  const vault=await createVault(directory,Buffer.from('archive snapshot passphrase'));await vault.close();
  const extra=await open(join(directory,'objects','11111111-1111-4111-8111-111111111111'),'wx');
  await extra.truncate(16*1048576);await extra.close();
  const exporting=exportVault({directory,output:join(root,'snapshot.scvault')});
  for(let attempt=0;attempt<100;attempt++){
    if((await readdir(directory)).includes('.lock'))break;
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  await assert.rejects(()=>acquireLock(directory),/already open/i);
  await exporting;
  assert.equal((await readdir(directory)).includes('.lock'),false);
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
  assert.equal((await readdir(root)).some(name=>name.endsWith('.importing')),false);
  const truncated=join(root,'truncated.scvault');await writeFile(truncated,bytes.subarray(0,bytes.length-1024));
  await assert.rejects(()=>importVault({archive:truncated,directory:restored}),/corrupt|truncated|unexpected end/i);
  assert.equal((await readdir(root)).some(name=>name.endsWith('.importing')),false);
});

test('import requires manifest identity to match vault.json',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-archive-identity-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'vault'),vault=await createVault(source,Buffer.from('archive identity passphrase'));
  await vault.close();
  const archive=join(root,'backup.scvault');await exportVault({directory:source,output:archive});
  const bytes=await readFile(archive),size=parseInt(bytes.toString('utf8',124,136).replace(/\0/g,'').trim(),8);
  const manifest=JSON.parse(bytes.toString('utf8',512,512+size));
  manifest.vaultId='11111111-1111-4111-8111-111111111111';
  const replacement=Buffer.from(`${JSON.stringify(manifest,null,1)}\n`);
  assert.equal(replacement.length,size);
  replacement.copy(bytes,512);
  const changed=join(root,'changed.scvault');await writeFile(changed,bytes);
  await assert.rejects(()=>importVault({archive:changed,directory:join(root,'restored')}),/identity|does not match/i);
  assert.equal((await readdir(root)).some(name=>name.endsWith('.importing')),false);
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
