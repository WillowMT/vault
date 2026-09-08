import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { readPassword } from '../src/cli/prompt.js';
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
});
