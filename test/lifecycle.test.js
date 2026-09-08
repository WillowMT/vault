import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp,rm,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request } from 'node:http';
async function launch(path,t){
  const child=fork(new URL('./fixtures/cli-child.js',import.meta.url),[path],{stdio:['ignore','pipe','pipe','ipc']});
  t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');});
  let errors='';child.stderr.on('data',d=>errors+=d);
  const ready=await Promise.race([once(child,'message').then(([value])=>value),once(child,'exit').then(()=>{throw new Error(`CLI exited before ready: ${errors}`);})]);
  return {child,...ready};
}
async function login(app){const response=await fetch(app.origin+'/api/session',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({token:new URL(app.launchUrl).hash.slice(1)})});assert.equal(response.status,200);const {csrfToken}=await response.json();return {Cookie:response.headers.get('set-cookie').split(';')[0],Origin:app.origin,'X-CSRF-Token':csrfToken};}
test('CLI signals stop HTTP; forced upload termination recovers committed files', {timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-life-')),path=join(root,'vault');t.after(()=>rm(root,{recursive:true,force:true}));
  let app=await launch(path,t),headers=await login(app);
  const response=await fetch(app.origin+'/api/files?name=keep.txt',{method:'POST',headers,body:'keep this encrypted'});assert.equal(response.status,201);const file=await response.json();
  const oldCookie=headers.Cookie;
  for(const signal of ['SIGINT','SIGTERM','SIGHUP']){
    const exited=once(app.child,'exit');app.child.kill(signal);await exited;
    await assert.rejects(fetch(app.origin+'/api/heartbeat'));
    app=await launch(path,t);assert.equal((await fetch(app.origin+'/api/entries',{headers:{Cookie:oldCookie}})).status,401);headers=await login(app);
    assert.equal(await (await fetch(`${app.origin}/api/files/${file.id}/download`,{headers})).text(),'keep this encrypted');
  }
  const upload=request(app.origin+'/api/files?name=interrupted.bin',{method:'POST',headers});upload.on('error',()=>{});upload.write(Buffer.alloc(2*1048576));
  // Wait for the encrypted partial to exist, not an arbitrary timing guess.
  for(let i=0;i<100;i++){if((await readdir(join(path,'objects'))).some(n=>n.endsWith('.partial')))break;await new Promise(r=>setTimeout(r,10));}
  const exited=once(app.child,'exit');app.child.kill('SIGKILL');await exited;upload.destroy();
  app=await launch(path,t);headers=await login(app);
  const listing=await (await fetch(app.origin+'/api/entries',{headers})).json();assert.equal(listing.entries.length,1);
  assert.equal(await (await fetch(`${app.origin}/api/files/${file.id}/download`,{headers})).text(),'keep this encrypted');
  assert.equal((await readdir(join(path,'objects'))).length,1);
  const finalExit=once(app.child,'exit');app.child.kill('SIGINT');await finalExit;
});
