import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtemp,rm,mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPassword,readText } from '../src/cli/prompt.js';
import { run } from '../src/cli/main.js';
import { renderStatus } from '../src/cli/view.js';
import { chooseVault } from '../src/cli/picker.js';

test('password input is hidden and supports backspace and Unicode',async()=>{
  const input=new PassThrough();input.isTTY=true;let raw=false;input.setRawMode=value=>{raw=value;};
  const output=new PassThrough();let text='';output.on('data',data=>text+=data);
  const password=readPassword({input,output,label:'Password'});
  input.write(Buffer.from('secretéx\x7f\r'));
  assert.equal((await password).toString(),'secreté');assert.equal(raw,false);assert.equal(text.includes('secret'),false);
});
test('password cancellation restores terminal and rejects non-TTY input',async()=>{
  const input=new PassThrough(),output=new PassThrough();
  await assert.rejects(readPassword({input,output,label:'Password'}),/terminal/i);
  input.isTTY=true;let raw=false;input.setRawMode=value=>{raw=value;};
  const password=readPassword({input,output,label:'Password'});input.write('\x03');
  await assert.rejects(password,/cancel/i);assert.equal(raw,false);
});
test('CLI help runs without prompting and rejects unknown options',()=>{
  const help=spawnSync(process.execPath,['bin/secretcli.js','--help'],{encoding:'utf8'});
  assert.equal(help.status,0);assert.match(help.stdout,/--vault/);
  const unknown=spawnSync(process.execPath,['bin/secretcli.js','--password','bad'],{encoding:'utf8'});
  assert.equal(unknown.status,1);assert.match(unknown.stderr,/Unknown option/);
});
test('status view supports narrow terminals and NO_COLOR style output',()=>{
  const view=renderStatus({origin:'http://127.0.0.1:4317',startedAt:Date.now()-120000,color:false,width:40});
  assert.match(view,/2m/);assert.match(view,/Ctrl\+C/);assert.equal(view.includes('\x1b'),false);
  assert.ok(view.split('\n').every(line=>line.length<=40));
  assert.match(renderStatus({origin:'http://localhost:1',startedAt:Date.now(),color:false,locked:true}),/waiting.*passkey.*recovery/i);
});
test('v1 vault unlocks once then starts browser-required enrollment',async()=>{
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  const output=new PassThrough();let text='';output.on('data',data=>text+=data);
  const password=Buffer.from('recovery password');let unlocks=0,enrollment,opened,renewals=0;
  let running;const ready=new Promise(resolve=>{
    running=run({argv:['--vault','/tmp'],stdin:input,stdout:output,passwordReader:async()=>Buffer.from(password),
      prepareVault:async()=>({version:1,close:async()=>{}}),unlockVault:async()=>{unlocks++;return {close:async()=>{}};},
      startEnrollmentServer:async(vault,recovery)=>{enrollment={vault,recovery:Buffer.from(recovery)};return {origin:'http://localhost:1',launchUrl:'http://localhost:1/',renewLaunchUrl(){renewals++;throw new Error('Not enrolled');},close:async()=>{}};},
      opener:async url=>{opened=url;},
      onReady:resolve});
  });
  await ready;for(let i=0;!opened&&i<20;i++)await new Promise(resolve=>setTimeout(resolve,1));input.write('l');await new Promise(resolve=>setTimeout(resolve,1));input.write('q');await running;
  assert.equal(unlocks,1);assert.ok(enrollment.recovery.equals(password));assert.equal(opened,'http://localhost:1/');assert.equal(renewals,0);assert.match(text,/passkey setup required/i);assert.doesNotMatch(text,/Could not create a browser link/);
});
test('new vault starts browser-required enrollment with its recovery password',async()=>{
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  const output=new PassThrough();let created,enrollment;
  let running;const path=`/tmp/secretcli-new-${process.pid}-${Date.now()}`;const ready=new Promise(resolve=>{
    running=run({argv:['--vault',path],stdin:input,stdout:output,passwordReader:async()=>Buffer.from('recovery password'),
      createVault:async(path,password)=>{created={path,password:Buffer.from(password)};return {close:async()=>{}};},
      startEnrollmentServer:async(vault,recovery)=>{enrollment={vault,recovery:Buffer.from(recovery)};return {origin:'http://localhost:1',launchUrl:'http://localhost:1/',close:async()=>{}};},
      onReady:resolve});
  });
  await ready;input.write('q');await running;
  assert.equal(created.password.toString(),'recovery password');assert.equal(enrollment.recovery.toString(),'recovery password');
});
test('v2 starts locked without a password prompt and R recovers into a fresh browser link',async()=>{
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  const output=new PassThrough();let prompts=0,recovery,opened;
  const app={origin:'http://localhost:1',launchUrl:'http://localhost:1/',recover:async password=>{recovery=Buffer.from(password);return 'http://localhost:1/#fresh';},close:async()=>{}};
  let running;const ready=new Promise(resolve=>{
    running=run({argv:['--vault','/tmp'],stdin:input,stdout:output,passwordReader:async()=>{prompts++;return Buffer.from('recovery password');},opener:async url=>{opened=url;},
      prepareVault:async()=>({version:2,close:async()=>{}}),startLockedServer:async()=>app,onReady:resolve});
  });
  await ready;assert.equal(prompts,0);input.write('r');
  for(let i=0;!opened&&i<20;i++)await new Promise(resolve=>setTimeout(resolve,1));
  input.write('q');await running;
  assert.equal(prompts,1);assert.equal(recovery.toString(),'recovery password');assert.equal(opened,'http://localhost:1/#fresh');
});
test('text prompt echoes input and supports backspace',async()=>{
  const input=new PassThrough();input.isTTY=true;let raw=false;input.setRawMode=value=>{raw=value;};
  const output=new PassThrough();let text='';output.on('data',data=>text+=data);
  const answer=readText({input,output,label:'Vault location'});
  input.write(Buffer.from('/tmp/ab\x7f\x7fc\r'));
  assert.equal((await answer).toString(),'/tmp/c');assert.equal(raw,false);
  assert.equal(text.includes('/tmp/c'),true);
});
test('vault picker selects by number and arrow keys, and quits on q',async()=>{
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  const output=new PassThrough();let text='';output.on('data',data=>text+=data);
  const entries=[{name:'alpha',path:'/tmp/a'},{name:'beta',path:'/tmp/b',missing:true}];
  const numbered=chooseVault({input,stdout:output,entries});
  input.write('2');
  assert.deepEqual(await numbered,{name:'beta',path:'/tmp/b',missing:true});
  const arrows=chooseVault({input,stdout:output,entries});
  input.write('\x1b[B\r');
  assert.equal((await arrows).name,'beta');
  const quit=chooseVault({input,stdout:output,entries});
  input.write('q');
  assert.equal(await quit,undefined);
  const create=chooseVault({input,stdout:output,entries,allowCreate:true});
  input.write('\x1b[B\x1b[B\r');
  assert.equal(await create,'create');
  const fallback=await chooseVault({input:new PassThrough(),stdout:output,entries:[{name:'a',path:'/a',lastOpenedAt:1},{name:'b',path:'/b',lastOpenedAt:5}]});
  assert.equal(fallback.name,'b');
});
test('vaults subcommand registers, lists, and removes vaults',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-vaults-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const registryPath=join(root,'vaults.json'),vault=join(root,'my-vault');
  await mkdir(vault);await writeFile(join(vault,'vault.json'),'{}');
  const output=new PassThrough();let text='';output.on('data',data=>text+=data);
  await run({argv:['vaults','--add',vault,'work'],stdin:new PassThrough(),stdout:output,registryPath});
  assert.match(text,/Registered “work”/);
  text='';await run({argv:['vaults'],stdin:new PassThrough(),stdout:output,registryPath});
  assert.match(text,/work/);assert.match(text,/my-vault/);
  await assert.rejects(run({argv:['vaults','--add',root,'second'],stdin:new PassThrough(),stdout:output,registryPath}),/vault\.json/);
  text='';await run({argv:['vaults','--remove','work'],stdin:new PassThrough(),stdout:output,registryPath});
  assert.match(text,/Files on disk were not touched/);
  text='';await run({argv:['vaults'],stdin:new PassThrough(),stdout:output,registryPath});
  assert.match(text,/No vaults registered/i);
  await assert.rejects(run({argv:['vaults','--remove','work'],stdin:new PassThrough(),stdout:output,registryPath}),/not registered/i);
});
test('--vault resolves registry names to registered paths',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-alias-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const registryPath=join(root,'vaults.json'),vault=join(root,'work-vault');
  await mkdir(vault);await writeFile(join(vault,'vault.json'),'{}');
  const output=new PassThrough();let text='';output.on('data',data=>text+=data);
  await run({argv:['vaults','--add',vault,'work'],stdin:new PassThrough(),stdout:output,registryPath});
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  let preparedPath;let running;const ready=new Promise(resolve=>{
    running=run({argv:['--vault','work'],registryPath,stdin:input,stdout:output,passwordReader:async()=>Buffer.from('recovery password'),
      prepareVault:async path=>{preparedPath=path;return {version:2,close:async()=>{}}},
      startLockedServer:async()=>({origin:'http://localhost:1',launchUrl:'http://localhost:1/',close:async()=>{}}),
      opener:async()=>{},onReady:resolve});
  });
  await ready;input.write('q');await running;
  assert.equal(preparedPath,vault);
});
test('launch without --vault opens the most recently used vault when several are registered',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-recent-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const registryPath=join(root,'vaults.json');
  await mkdir(join(root,'older'),{recursive:true});await mkdir(join(root,'newer'),{recursive:true});
  const output=new PassThrough();let text='';output.on('data',data=>text+=data);
  const {registerVault,saveRegistry}=await import('../src/vault/registry.js');
  let registry={version:1,vaults:[]};
  registry=(await registerVault(registry,join(root,'older'),'older')).registry;
  registry=(await registerVault(registry,join(root,'newer'),'newer')).registry;
  registry.vaults[0].lastOpenedAt=1;registry.vaults[1].lastOpenedAt=2;
  await saveRegistry(registryPath,registry);
  let preparedPath;let running;const ready=new Promise(resolve=>{
    running=run({argv:[],registryPath,stdin:new PassThrough(),stdout:output,passwordReader:async()=>Buffer.from('recovery password'),
      prepareVault:async path=>{preparedPath=path;return {version:2,close:async()=>{}}},
      startLockedServer:async()=>({origin:'http://localhost:1',launchUrl:'http://localhost:1/',close:async()=>{}}),
      opener:async()=>{},onReady:resolve});
  });
  await ready;process.emit('SIGINT');await running;
  assert.equal(preparedPath,join(root,'newer'));
});
test('export and import commands round-trip a vault and register the copy',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-export-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const registryPath=join(root,'vaults.json'),vault=join(root,'source'),restored=join(root,'restored');
  const {createVault}=await import('../src/vault/vault.js');
  const original=await createVault(vault,Buffer.from('export cli passphrase'));
  await original.upload(null,'note.txt','text/plain',[Buffer.from('cli export works')]);
  await original.close();
  const output=new PassThrough();let text='';output.on('data',data=>text+=data);
  await assert.rejects(run({argv:['export','--vault',vault],stdin:new PassThrough(),stdout:output,registryPath}),/--to/);
  const archive=join(root,'backup.scvault');
  text='';await run({argv:['export','--vault',vault,'--to',archive],stdin:new PassThrough(),stdout:output,registryPath});
  assert.match(text,/Exported/);assert.match(text,/backup\.scvault/);
  text='';await run({argv:['import',archive,'--out',restored,'--name','copy'],stdin:new PassThrough(),stdout:output,registryPath});
  assert.match(text,/Imported/);assert.match(text,/“copy”/);
  const {loadRegistry}=await import('../src/vault/registry.js');
  const {registry}=await loadRegistry(registryPath);
  assert.equal(registry.vaults.find(entry=>entry.name==='copy')?.path,restored);
  const {unlockVault}=await import('../src/vault/vault.js');
  const reopened=await unlockVault(restored,Buffer.from('export cli passphrase'));
  const chunks=[];for await(const bytes of reopened.read((await reopened.list(null,'',{recursive:true}))[0].id))chunks.push(bytes);
  await reopened.close();
  assert.equal(Buffer.concat(chunks).toString(),'cli export works');
  text='';await run({argv:['export','--vault','copy','--to',join(root,'second.scvault')],stdin:new PassThrough(),stdout:output,registryPath});
  assert.match(text,/Exported/);
});
test('import refuses an existing destination and reports registry conflicts',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-import-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const registryPath=join(root,'vaults.json'),vault=join(root,'source');
  const {createVault}=await import('../src/vault/vault.js');
  const original=await createVault(vault,Buffer.from('import cli passphrase'));
  await original.close();
  const archive=join(root,'backup.scvault');
  const output=new PassThrough();let text='';output.on('data',data=>text+=data);
  await run({argv:['export','--vault',vault,'--to',archive],stdin:new PassThrough(),stdout:output,registryPath});
  await run({argv:['import',archive,'--out',join(root,'copy'),'--name','dup'],stdin:new PassThrough(),stdout:output,registryPath});
  await assert.rejects(run({argv:['import',archive,'--out',join(root,'copy')],stdin:new PassThrough(),stdout:output,registryPath}),/already exists/i);
  text='';await run({argv:['import',archive,'--out',join(root,'other'),'--name','dup'],stdin:new PassThrough(),stdout:output,registryPath});
  assert.match(text,/could not be registered/i);
});
