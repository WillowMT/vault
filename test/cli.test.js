import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { readPassword } from '../src/cli/prompt.js';
import { run } from '../src/cli/main.js';
import { renderStatus } from '../src/cli/view.js';

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
