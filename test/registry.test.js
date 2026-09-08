import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRegistry, saveRegistry, sanitizeName, uniqueName, resolveReference, registerVault, touchVault, forgetVault, emptyRegistry } from '../src/vault/registry.js';

test('loadRegistry returns an empty registry when the file is missing',async()=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-registry-'));
  try{
    const {registry,warning}=await loadRegistry(join(root,'vaults.json'));
    assert.deepEqual(registry,{version:1,vaults:[]});
    assert.equal(warning,undefined);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('loadRegistry recovers with a warning from corrupt JSON',async()=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-registry-'));
  try{
    await writeFile(join(root,'vaults.json'),'{not json');
    const {registry,warning}=await loadRegistry(join(root,'vaults.json'));
    assert.deepEqual(registry,{version:1,vaults:[]});
    assert.match(warning,/could not be read/i);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('loadRegistry drops invalid and duplicate entries, keeps valid ones',async()=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-registry-'));
  try{
    await writeFile(join(root,'vaults.json'),JSON.stringify({version:2,vaults:[
      {name:'good',path:'/tmp/keep'},
      {name:'Bad Name',path:'/tmp/one'},
      {name:'dup',path:'/tmp/one'},
      {name:'no-path'},
      {name:'good',path:'/tmp/other'},
      'junk'
    ]}));
    const {registry,warning}=await loadRegistry(join(root,'vaults.json'));
    assert.deepEqual(registry.vaults,[{name:'good',path:'/tmp/keep'},{name:'dup',path:'/tmp/one'}]);
    assert.match(warning,/4 invalid/i);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('saveRegistry writes atomically and round-trips through loadRegistry',async()=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-registry-'));
  try{
    const file=join(root,'vaults.json');
    const registry={version:1,vaults:[{name:'work',path:'/tmp/work',lastOpenedAt:100}]};
    await saveRegistry(file,registry);
    assert.equal((await readFile(file,'utf8')).trim().startsWith('{'),true);
    const {registry:loaded,warning}=await loadRegistry(file);
    assert.equal(warning,undefined);
    assert.deepEqual(loaded,registry);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('sanitizeName lowercases and strips characters, never returns empty',async()=>{
  assert.equal(sanitizeName('Café 02'),'cafe-02');
  assert.equal(sanitizeName('  ///  '),'vault');
  assert.equal(sanitizeName('My Vault!'),'my-vault');
});

test('uniqueName appends counters until the name is free',async()=>{
  const registry=emptyRegistry();
  registry.vaults.push({name:'vault',path:'/tmp/a'});
  assert.equal(uniqueName(registry,'vault'),'vault-2');
  registry.vaults.push({name:'vault-2',path:'/tmp/b'});
  assert.equal(uniqueName(registry,'vault'),'vault-3');
  assert.equal(uniqueName(registry,'fresh'),'fresh');
});

test('registerVault validates names, uniqueness, and normalizes paths',async()=>{
  let registry=emptyRegistry();
  const first=await registerVault(registry,'/tmp/my vault','work');
  registry=first.registry;
  assert.equal(first.entry.name,'work');
  assert.equal(first.entry.path,'/tmp/my vault');
  await assert.rejects(()=>registerVault(registry,'/tmp/other','work'),/already in use/i);
  await assert.rejects(()=>registerVault(registry,'/tmp/my vault','else'),/already registered/i);
  await assert.rejects(()=>registerVault(registry,'/tmp/x','NOT VALID'),/lowercase/);
  await assert.rejects(()=>registerVault(registry,'/tmp/x',''),/lowercase/);
  await assert.rejects(()=>registerVault(registry,'relative/path','ok'),/absolute/);
  const second=await registerVault(registry,'/tmp/other');
  registry=second.registry;
  assert.equal(second.entry.name,'other');
});

test('resolveReference matches registry names only',async()=>{
  const registry=emptyRegistry();
  registry.vaults.push({name:'work',path:'/tmp/work'});
  assert.equal(resolveReference(registry,'work')?.path,'/tmp/work');
  assert.equal(resolveReference(registry,'/tmp/work'),undefined);
  assert.equal(resolveReference(registry,'missing'),undefined);
});

test('touchVault updates lastOpenedAt only for known paths',async()=>{
  const registry=emptyRegistry();
  registry.vaults.push({name:'work',path:'/tmp/work'});
  const before=Date.now();
  assert.equal(touchVault(registry,'/tmp/work').vaults[0].lastOpenedAt>=before,true);
  assert.equal(touchVault(registry,'/tmp/unknown').vaults.length,1);
});

test('forgetVault removes the entry and rejects unknown names',async()=>{
  const registry=emptyRegistry();
  registry.vaults.push({name:'work',path:'/tmp/work'});
  const remaining=forgetVault(registry,'work');
  assert.deepEqual(remaining.vaults,[]);
  assert.throws(()=>forgetVault(remaining,'work'),/not registered/i);
});
