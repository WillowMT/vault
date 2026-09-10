import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault } from '../src/vault/vault.js';
import { startServer } from '../src/server/server.js';
import { parseRange } from '../src/server/ranges.js';
import { request } from 'node:http';
import { Readable } from 'node:stream';

async function login(app, launchUrl = app.launchUrl) {
  const response=await fetch(app.origin+'/api/session',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({token:new URL(launchUrl).hash.slice(1)})});
  assert.equal(response.status,200);
  const {csrfToken}=await response.json();
  return {cookie:response.headers.get('set-cookie').split(';')[0],csrfToken};
}

test('range parser supports seeking and rejects invalid requests',()=>{
  assert.deepEqual(parseRange('bytes=2-4',10),{start:2,end:4});
  assert.deepEqual(parseRange('bytes=-3',10),{start:7,end:9});
  assert.deepEqual(parseRange('bytes=8-',10),{start:8,end:9});
  for(const h of ['bytes=11-','bytes=4-2','bytes=0-1,3-4','bytes=-0'])assert.throws(()=>parseRange(h,10));
});
test('HTTP protects data, streams ranges, and expires sessions on shutdown',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-http-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('test server passphrase'));
  let app=await startServer(vault);
  t.after(async()=>{await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const url=path=>app.origin+path;
  assert.equal((await fetch(url('/api/entries'))).status,401);
  const forgedStatus=await new Promise((resolve,reject)=>{const req=request(url('/api/entries'),{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(forgedStatus,403);
  const token=new URL(app.launchUrl).hash.slice(1);
  const login=()=>fetch(url('/api/session'),{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({token})});
  const response=await login();assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'),/HttpOnly/);
  const {csrfToken}=await response.json();
  assert.equal((await login()).status,401);
  const headers={Cookie:cookie,Origin:app.origin,'X-CSRF-Token':csrfToken,'Content-Type':'application/json'};
  assert.equal((await fetch(url('/api/folders'),{method:'POST',headers:{Cookie:cookie},body:'{}'})).status,403);
  const folderResponse=await fetch(url('/api/folders'),{method:'POST',headers,body:JSON.stringify({parentId:null,name:'Media'})});
  assert.equal(folderResponse.status,201);const folder=await folderResponse.json();
  const uploaded=await fetch(url(`/api/files?parentId=${folder.id}&name=clip.mp4`),{method:'POST',headers:{...headers,'Content-Type':'video/mp4'},body:'0123456789'});
  assert.equal(uploaded.status,201);const file=await uploaded.json();
  const second=await vault.upload(null,'second.txt','text/plain',[Buffer.from('two')]);
  const csrfRejected=await fetch(url('/api/entries/bulk-move'),{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({ids:[file.id],parentId:folder.id})});
  assert.equal(csrfRejected.status,403);
  const moved=await fetch(url('/api/entries/bulk-move'),{method:'POST',headers,body:JSON.stringify({ids:[file.id,second.id],parentId:folder.id})});
  assert.equal(moved.status,200);assert.deepEqual(await moved.json(),{moved:2});
  const emptyIds=await fetch(url('/api/entries/bulk-delete'),{method:'POST',headers,body:JSON.stringify({ids:[]})});
  assert.equal(emptyIds.status,400);
  const range=await fetch(url(`/api/files/${file.id}/content`),{headers:{Cookie:cookie,Range:'bytes=2-4'}});
  assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 2-4/10');assert.equal(await range.text(),'234');
  assert.equal((await fetch(url(`/api/files/${file.id}/content`),{headers:{Cookie:cookie,Range:'bytes=99-'}})).status,416);
  const html=await vault.upload(null,'attack.html','text/html',[Buffer.from('<script>alert(1)</script>')]);
  const dangerous=await fetch(url(`/api/files/${html.id}/content`),{headers:{Cookie:cookie}});
  assert.match(dangerous.headers.get('content-disposition'),/^attachment/);
  assert.equal(dangerous.headers.get('content-type'),'application/octet-stream');
  assert.equal(dangerous.headers.get('cache-control'),'no-store');
  const deleted=await fetch(url('/api/entries/bulk-delete'),{method:'POST',headers,body:JSON.stringify({ids:[file.id,second.id]})});
  assert.equal(deleted.status,200);assert.deepEqual(await deleted.json(),{deleted:2});
  const oldOrigin=app.origin;await app.close();
  await assert.rejects(fetch(oldOrigin+'/api/heartbeat'));
  app=await startServer(vault);
  assert.equal((await fetch(url('/api/entries'),{headers:{Cookie:cookie}})).status,401);
});
test('PDF and text files serve inline for in-browser preview',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-inline-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('inline preview passphrase'));
  const app=await startServer(vault);
  t.after(async()=>{await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const url=path=>app.origin+path;
  const token=new URL(app.launchUrl).hash.slice(1);
  const session=await fetch(url('/api/session'),{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({token})});
  const cookie=session.headers.get('set-cookie').split(';')[0];
  const headers={Cookie:cookie};
  const pdf=await vault.upload(null,'doc.pdf','application/pdf',[Buffer.from('%PDF-1.4 minimal')]);
  const pdfResponse=await fetch(url(`/api/files/${pdf.id}/content`),{headers});
  assert.equal(pdfResponse.headers.get('content-type'),'application/pdf');
  assert.match(pdfResponse.headers.get('content-disposition'),/^inline/);
  const text=await vault.upload(null,'notes.txt','text/plain',[Buffer.from('hello secret')]);
  const textResponse=await fetch(url(`/api/files/${text.id}/content`),{headers});
  assert.equal(textResponse.headers.get('content-type'),'text/plain');
  assert.match(textResponse.headers.get('content-disposition'),/^inline/);
  assert.equal(await textResponse.text(),'hello secret');
  const page=await fetch(url('/'),{headers});
  const csp=page.headers.get('content-security-policy');
  assert.match(csp,/frame-src 'self'/);
  assert.match(csp,/object-src 'none'/);
});

test('download tickets are validated, session-bound, expiring, single-use ZIP streams',async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-download-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('download test passphrase'));
  const app=await startServer(vault);
  t.after(async()=>{await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const folder=await vault.mkdir(null,'Folder');
  const file=await vault.upload(folder.id,'hello.txt','text/plain',[Buffer.from('hello')]);
  const first=await login(app);
  const post=(ids,session=first)=>fetch(app.origin+'/api/downloads',{method:'POST',headers:{Cookie:session.cookie,Origin:app.origin,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json'},body:JSON.stringify({ids})});

  assert.equal((await fetch(app.origin+'/api/downloads',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({ids:[folder.id]})})).status,401);
  assert.equal((await fetch(app.origin+'/api/downloads',{method:'POST',headers:{Cookie:first.cookie,Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({ids:[folder.id]})})).status,403);
  for(const ids of [[],['not-a-uuid'],[file.id,file.id],Array(10001).fill(file.id)])assert.equal((await post(ids)).status,400);

  const ticketResponse=await post([folder.id]);
  assert.equal(ticketResponse.status,201);
  const ticket=await ticketResponse.json();
  assert.match(ticket.url,/^\/api\/downloads\/[a-f0-9]{64}$/);

  const secondLaunch=app.renewLaunchUrl();
  const second=await login(app,secondLaunch);
  assert.equal((await fetch(app.origin+ticket.url,{headers:{Cookie:second.cookie}})).status,404);

  const freshResponse=await post([folder.id],second);
  const fresh=await freshResponse.json();
  const archive=await fetch(app.origin+fresh.url,{headers:{Cookie:second.cookie}});
  assert.equal(archive.status,200);
  assert.equal(archive.headers.get('content-type'),'application/zip');
  assert.match(archive.headers.get('content-disposition'),/^attachment/);
  assert.equal(archive.headers.get('cache-control'),'no-store');
  assert.equal((await archive.arrayBuffer()).byteLength>0,true);
  assert.equal((await fetch(app.origin+fresh.url,{headers:{Cookie:second.cookie}})).status,404);

  const expiring=await (await post([file.id],second)).json();
  const now=Date.now;
  Date.now=()=>now()+31000;
  try { assert.equal((await fetch(app.origin+expiring.url,{headers:{Cookie:second.cookie}})).status,404); }
  finally { Date.now=now; }
});

test('server shutdown cancels an active ZIP reader and releases its export once',async t=>{
  let source,releaseCount=0,startedResolve;
  const started=new Promise(resolve=>{startedResolve=resolve;});
  const vault={vaultId:'00000000-0000-4000-8000-000000000000',async openExport(){
    source=new Readable({read(){if(this.sent)return;this.sent=true;this.push(Buffer.from('x'));startedResolve();}});
    return {entries:[{kind:'file',path:'stalled.bin',size:2,open:()=>source}],release:async()=>{releaseCount++;}};
  }};
  const app=await startServer(vault);
  t.after(()=>app.close());
  const session=await login(app);
  const ticket=await (await fetch(app.origin+'/api/downloads',{method:'POST',headers:{Cookie:session.cookie,Origin:app.origin,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json'},body:JSON.stringify({ids:['00000000-0000-4000-8000-000000000001']})})).json();
  const response=await fetch(app.origin+ticket.url,{headers:{Cookie:session.cookie}});
  await started;

  const body=response.arrayBuffer();
  await app.close();
  await assert.rejects(body);
  assert.equal(source.destroyed,true);
  assert.equal(releaseCount,1);
});
