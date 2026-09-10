import test from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from 'happy-dom';
import { mkdtemp,rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Window } from 'happy-dom';
import { createVault } from '../src/vault/vault.js';
import { startServer } from '../src/server/server.js';
async function until(fn,message){for(let i=0;i<150;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error(typeof message==='function'?message():message);}

async function unlockPage(mode,responses,credentials){
  const window=new Window({url:'http://localhost/'}),requests=[];
  window.document.body.dataset.mode=mode;
  window.document.body.innerHTML=`<main><h1>${mode}</h1></main>`;
  window.PublicKeyCredential=class {};
  Object.defineProperty(window.navigator,'credentials',{value:credentials});
  window.fetch=async(path,init={})=>{
    requests.push([path,JSON.parse(init.body||'{}')]);
    return {ok:true,json:async()=>responses.shift()};
  };
  const helpers=(await readFile(new URL('../web/webauthn.js',import.meta.url),'utf8')).replace(/^export /gm,'');
  const unlock=(await readFile(new URL('../web/unlock.js',import.meta.url),'utf8')).replace(/^import .*;$/m,'');
  window.eval(`${helpers}\n${unlock}`);
  return {window,requests};
}

test('locked unlock page sends a serialized assertion and 32-byte PRF result',async()=>{
  const result=Uint8Array.from({length:32},(_,i)=>i);
  const credential={id:'credential-id',rawId:Uint8Array.of(1,2).buffer,type:'public-key',response:{authenticatorData:Uint8Array.of(3).buffer,clientDataJSON:Uint8Array.of(4).buffer,signature:Uint8Array.of(5).buffer,userHandle:null},getClientExtensionResults:()=>({prf:{results:{first:result.buffer}}})};
  const {window,requests}=await unlockPage('locked',[{challenge:'AQI',allowCredentials:[{id:'AwQ',type:'public-key'}]}],{get:async options=>{assert.equal(options.publicKey.challenge.byteLength,2);return credential;}});

  window.document.querySelector('button').click();
  await until(()=>requests.length===2,()=>`Authentication did not complete: ${requests.length} ${window.document.querySelector('.unlock-message').textContent}`);
  assert.equal(requests[0][0],'/api/passkey/authentication/options');
  assert.equal(requests[1][0],'/api/passkey/authentication/verify');
  assert.deepEqual(requests[1][1],{credential:{id:'credential-id',rawId:'AQI',type:'public-key',response:{authenticatorData:'Aw',clientDataJSON:'BA',signature:'BQ',userHandle:null},clientExtensionResults:{prf:{results:{first:'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'}}}},prf:Buffer.from(result).toString('base64url')});
});

test('enrollment page confirms the registered credential with its PRF result',async()=>{
  const result=Uint8Array.from({length:32},(_,i)=>31-i);
  const response=Object.create({getTransports:()=>['internal']});
  Object.defineProperties(response,{attestationObject:{value:Uint8Array.of(2).buffer},clientDataJSON:{value:Uint8Array.of(3).buffer}});
  const registered={id:'new-credential',rawId:Uint8Array.of(1).buffer,type:'public-key',authenticatorAttachment:'platform',response};
  const confirmed={id:'new-credential',rawId:Uint8Array.of(1).buffer,type:'public-key',response:{authenticatorData:Uint8Array.of(4).buffer,clientDataJSON:Uint8Array.of(5).buffer,signature:Uint8Array.of(6).buffer,userHandle:null},getClientExtensionResults:()=>({prf:{results:{first:result.buffer}}})};
  let gets=0;
  const registration={challenge:'AQI',rp:{id:'localhost',name:'Vault'},user:{id:'BQY',name:'vault',displayName:'Vault'}};
  const confirmation={challenge:'AwQ',allowCredentials:[{id:'AQ',type:'public-key'}]};
  const {window,requests}=await unlockPage('enrollment',[registration,confirmation],{create:async options=>{assert.equal(options.publicKey.rp.id,'localhost');assert.equal(options.publicKey.user.id.byteLength,2);return registered;},get:async options=>{gets++;assert.equal(options.publicKey.allowCredentials[0].id.byteLength,1);return confirmed;}});

  window.document.querySelector('button').click();
  await until(()=>requests.length===3,()=>`Enrollment did not complete: ${requests.length} ${window.document.querySelector('.unlock-message').textContent}`);
  assert.deepEqual(requests.map(([path])=>path),['/api/passkey/registration/options','/api/passkey/registration/verify','/api/passkey/registration/confirm']);
  assert.equal(gets,1);
  assert.equal(requests[1][1].credential.response.attestationObject,'Ag');
  assert.equal(requests[1][1].credential.response.clientDataJSON,'Aw');
  assert.equal(requests[1][1].credential.authenticatorAttachment,'platform');
  assert.equal(requests[2][1].prf,Buffer.from(result).toString('base64url'));
});

test('unlock page directs the user to terminal recovery when PRF is unavailable',async()=>{
  const credential={id:'credential-id',rawId:Uint8Array.of(1).buffer,type:'public-key',response:{authenticatorData:Uint8Array.of(2).buffer,clientDataJSON:Uint8Array.of(3).buffer,signature:Uint8Array.of(4).buffer,userHandle:null},getClientExtensionResults:()=>({})};
  const {window,requests}=await unlockPage('locked',[{challenge:'AQ'}],{get:async()=>credential});

  window.document.querySelector('button').click();
  await until(()=>window.document.querySelector('.unlock-message').textContent.includes('terminal'),'PRF recovery instruction was not shown');
  assert.equal(requests.length,1);
});
test('browser UI creates folders, uploads, searches, renames, moves and clears on disconnect',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-web-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('browser test passphrase'));
  const app=await startServer(vault);
  // Only our own local app code runs here, never uploaded file content.
  // Happy DOM omits Origin on same-origin POSTs; real browsers supply it.
  const browser=new Browser({settings:{enableJavaScriptEvaluation:true,suppressInsecureJavaScriptEnvironmentWarning:true,fetch:{requestHeaders:[{headers:{Origin:app.origin}}]}}});
  t.after(async()=>{await browser.close();await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const page=browser.newPage();await page.goto(app.launchUrl);
  const window=page.mainFrame.window,doc=window.document;
  await until(()=>doc.querySelector('#item-count')?.textContent==='0 items',()=>`App did not initialize: ${page.virtualConsolePrinter.readAsString()} ${doc.body.textContent.slice(-500)}`);
  assert.equal(page.url.includes('#'),false);
  const nativeFetch=window.fetch.bind(window);let finishStale;
  window.fetch=(path,init)=>path==='/api/folders'&&init?.method==='POST'?new Promise(resolve=>{finishStale=()=>resolve({ok:true,status:201,json:async()=>({})});}):nativeFetch(path,init);
  doc.querySelector('#new-folder').click();doc.querySelector('#entry-name').value='Stale';doc.querySelector('#action-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  doc.querySelector('#dialog-cancel').click();doc.querySelector('#new-folder').click();doc.querySelector('#entry-name').value='Fresh';finishStale();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(doc.querySelector('#action-dialog').open,true,'Stale action closed a newer dialog');
  assert.equal(doc.querySelector('#entry-name').value,'Fresh','Stale action overwrote a newer dialog');
  doc.querySelector('#dialog-cancel').click();window.fetch=nativeFetch;
  doc.querySelector('#new-folder').click();doc.querySelector('#entry-name').value='Pictures';doc.querySelector('#action-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>doc.querySelector('.file-name-text')?.textContent==='Pictures','Folder did not appear');
  const input=doc.querySelector('#file-input');const transfer=new window.DataTransfer();transfer.items.add(new window.File(['test image'],'photo.png',{type:'image/png'}));input.files=transfer.files;input.dispatchEvent(new window.Event('change'));
  await until(()=>[...doc.querySelectorAll('.file-name-text')].some(n=>n.textContent==='photo.png'),'Upload did not finish');
  const row=[...doc.querySelectorAll('.file-row')].find(n=>n.textContent.includes('photo.png'));
  [...row.querySelectorAll('button')].find(n=>n.textContent==='Rename').click();doc.querySelector('#entry-name').value='renamed.png';doc.querySelector('#action-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  await until(()=>[...doc.querySelectorAll('.file-name-text')].some(n=>n.textContent==='renamed.png'),'Rename failed');
  const renamed=[...doc.querySelectorAll('.file-row')].find(n=>n.textContent.includes('renamed.png'));
  [...renamed.querySelectorAll('button')].find(n=>n.textContent==='Move to folder').click();const select=doc.querySelector('#destination');select.value=[...select.options].find(o=>o.textContent==='Pictures').value;doc.querySelector('#action-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  await until(()=>doc.querySelectorAll('.file-row').length===1,'Move failed');
  const search=doc.querySelector('#search');search.value='renamed';search.dispatchEvent(new window.Event('input'));
  await until(()=>doc.querySelector('.file-name-text')?.textContent==='renamed.png','Global filename search failed');
  doc.querySelector('#grid-view').click();assert.ok(doc.querySelector('.file-card'));
  const card=[...doc.querySelectorAll('.file-card')].find(n=>n.textContent.includes('renamed.png'));
  assert.ok(card?.querySelector('.file-thumb .file-icon'),'Grid card lacks thumbnail tile with icon fallback');
  await app.close();
  await until(()=>doc.querySelector('.locked-page'),'View did not clear on disconnect');
  assert.equal(doc.body.textContent.includes('renamed.png'),false);assert.equal(doc.body.textContent.includes('Pictures'),false);
  assert.equal(page.virtualConsolePrinter.readAsString().includes('TypeError'),false);
});
test('preview dialog renders pdf, text, and voice-note players',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-preview-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('preview test passphrase'));
  const app=await startServer(vault);
  const browser=new Browser({settings:{enableJavaScriptEvaluation:true,suppressInsecureJavaScriptEnvironmentWarning:true,fetch:{requestHeaders:[{headers:{Origin:app.origin}}]}}});
  t.after(async()=>{await browser.close();await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const page=browser.newPage();await page.goto(app.launchUrl);
  const window=page.mainFrame.window,doc=window.document;
  await until(()=>doc.querySelector('#item-count')?.textContent==='0 items','App did not initialize');
  const input=doc.querySelector('#file-input');
  const transfer=new window.DataTransfer();
  transfer.items.add(new window.File(['%PDF-1.4 minimal'],'doc.pdf',{type:'application/pdf'}));
  transfer.items.add(new window.File(['hello secret vault'],'notes.txt',{type:'text/plain'}));
  transfer.items.add(new window.File(['fake audio'],'voice.mp3',{type:'audio/mpeg'}));
  input.files=transfer.files;input.dispatchEvent(new window.Event('change'));
  await until(()=>doc.querySelectorAll('.file-row').length===3,'Uploads did not finish');
  async function open(name){const row=[...doc.querySelectorAll('.file-row')].find(n=>n.textContent.includes(name));[...row.querySelectorAll('button')].find(n=>n.textContent==='Preview').click();await until(()=>doc.querySelector('#preview-dialog[open]'),`${name} preview did not open`);}
  await open('doc.pdf');
  const frame=doc.querySelector('#preview-content iframe.pdf-frame');
  assert.ok(frame,'PDF iframe missing');assert.ok(frame.src.includes('/content'),'PDF iframe src wrong');
  doc.querySelector('#preview-close').click();
  const nativeFetch=window.fetch.bind(window);let finishText;
  window.fetch=(path,init)=>String(path).endsWith('/content')?new Promise(resolve=>{finishText=()=>resolve({ok:true,body:null,text:async()=>'stale text'});}):nativeFetch(path,init);
  await open('notes.txt');doc.querySelector('#preview-close').click();await open('voice.mp3');finishText();await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(doc.querySelector('#preview-content .voice-note'),'Stale text response replaced a newer preview');
  doc.querySelector('#preview-close').click();window.fetch=nativeFetch;
  await open('notes.txt');
  assert.ok(!doc.querySelector('#preview-dialog').classList.contains('slideshow'),'Text preview must not use slideshow mode');
  const pre=await (async()=>{for(let i=0;i<150;i++){const node=doc.querySelector('#preview-content pre.text-preview');if(node?.textContent==='hello secret vault')return node;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Text preview did not load');})();
  assert.ok(pre,'Text preview missing');
  doc.querySelector('#preview-close').click();
  await open('voice.mp3');
  const player=doc.querySelector('#preview-content .voice-note');
  assert.ok(player?.querySelector('audio'),'Voice-note player missing');
  const speed=player.querySelector('.voice-speed');
  assert.equal(speed.textContent,'1×');
  speed.click();assert.equal(player.querySelector('audio').playbackRate,1.25);
  speed.click();assert.equal(player.querySelector('audio').playbackRate,1.5);
  doc.querySelector('#preview-close').click();
  assert.equal(page.virtualConsolePrinter.readAsString().includes('TypeError'),false);
});
test('image preview navigates the gallery with arrows and keyboard',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-gallery-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('gallery test passphrase'));
  const app=await startServer(vault);
  const browser=new Browser({settings:{enableJavaScriptEvaluation:true,suppressInsecureJavaScriptEnvironmentWarning:true,fetch:{requestHeaders:[{headers:{Origin:app.origin}}]}}});
  t.after(async()=>{await browser.close();await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const page=browser.newPage();await page.goto(app.launchUrl);
  const window=page.mainFrame.window,doc=window.document;
  await until(()=>doc.querySelector('#item-count')?.textContent==='0 items','App did not initialize');
  const input=doc.querySelector('#file-input');
  const transfer=new window.DataTransfer();
  transfer.items.add(new window.File(['first'],'sunrise.png',{type:'image/png'}));
  transfer.items.add(new window.File(['second'],'sunset.png',{type:'image/png'}));
  input.files=transfer.files;input.dispatchEvent(new window.Event('change'));
  await until(()=>doc.querySelectorAll('.file-row').length===2,'Uploads did not finish');
  const open=name=>{const row=[...doc.querySelectorAll('.file-row')].find(n=>n.textContent.includes(name));[...row.querySelectorAll('button')].find(n=>n.textContent==='Preview').click();return until(()=>doc.querySelector('#preview-dialog[open]'),`${name} preview did not open`);};
  const title=()=>doc.querySelector('#preview-title').textContent;
  await open('sunrise.png');
  const dialog=doc.querySelector('#preview-dialog');
  assert.ok(dialog.classList.contains('slideshow'),'Image preview must open in slideshow mode');
  assert.ok(doc.querySelector('.gallery-prev')&&doc.querySelector('.gallery-next'),'Gallery arrows missing');
  assert.equal(doc.querySelector('.gallery-counter').textContent,'1 / 2','Counter should show first position');
  assert.ok(doc.querySelector('.gallery-fullscreen'),'Fullscreen toggle missing');
  assert.equal(doc.querySelector('#preview-download').getAttribute('download'),'sunrise.png','Download must target the shown file');
  doc.querySelector('.gallery-next').click();
  await until(()=>title()==='sunset.png','Next arrow did not advance to sunset.png');
  assert.equal(doc.querySelector('.gallery-counter').textContent,'2 / 2','Counter should follow navigation');
  dialog.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  await until(()=>title()==='sunrise.png','ArrowRight did not wrap to sunrise.png');
  dialog.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  await until(()=>title()==='sunset.png','ArrowLeft did not step back to sunset.png');
  let fullscreen=false,exits=0;
  Object.defineProperty(doc,'fullscreenElement',{configurable:true,get:()=>fullscreen?doc.documentElement:null});
  doc.documentElement.requestFullscreen=async()=>{fullscreen=true;};
  doc.exitFullscreen=async()=>{fullscreen=false;exits++;};
  doc.querySelector('.gallery-fullscreen').click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(fullscreen,true,'Fullscreen toggle did not enter fullscreen');
  doc.querySelector('#preview-close').click();
  await until(()=>!doc.querySelector('#preview-dialog[open]'),'Preview did not close');
  assert.equal(exits,1,'Closing slideshow did not exit fullscreen');
  await open('sunset.png');
  assert.ok(doc.querySelector('.gallery-next'),'Arrows missing after reopening');
  doc.querySelector('#preview-close').click();
  assert.equal(page.virtualConsolePrinter.readAsString().includes('TypeError'),false);
});
test('video preview navigates the gallery with arrows and keyboard',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-video-gallery-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('video gallery test passphrase'));
  const app=await startServer(vault);
  const browser=new Browser({settings:{enableJavaScriptEvaluation:true,suppressInsecureJavaScriptEnvironmentWarning:true,fetch:{requestHeaders:[{headers:{Origin:app.origin}}]}}});
  t.after(async()=>{await browser.close();await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const page=browser.newPage();await page.goto(app.launchUrl);
  const window=page.mainFrame.window,doc=window.document;
  await until(()=>doc.querySelector('#item-count')?.textContent==='0 items','App did not initialize');
  const input=doc.querySelector('#file-input');
  const transfer=new window.DataTransfer();
  transfer.items.add(new window.File(['first'],'first.webm',{type:'video/webm'}));
  transfer.items.add(new window.File(['second'],'second.webm',{type:'video/webm'}));
  input.files=transfer.files;input.dispatchEvent(new window.Event('change'));
  await until(()=>doc.querySelectorAll('.file-row').length===2,'Uploads did not finish');
  const open=name=>{const row=[...doc.querySelectorAll('.file-row')].find(n=>n.textContent.includes(name));[...row.querySelectorAll('button')].find(n=>n.textContent==='Preview').click();return until(()=>doc.querySelector('#preview-dialog[open]'),`${name} preview did not open`);};
  const title=()=>doc.querySelector('#preview-title').textContent;
  await open('first.webm');
  assert.ok(doc.querySelector('#preview-dialog').classList.contains('slideshow'),'Video preview must open in slideshow mode');
  const video=doc.querySelector('video');
  assert.equal(video.autoplay,true,'Video preview must autoplay');
  assert.equal(video.muted,true,'Autoplaying video must start muted for browser compatibility');
  assert.equal(video.playsInline,true,'Video must remain inline on mobile');
  assert.ok(doc.querySelector('.gallery-prev')&&doc.querySelector('.gallery-next'),'Gallery arrows missing');
  assert.equal(doc.querySelector('.gallery-counter').textContent,'1 / 2','Counter should show first position');
  assert.ok(doc.querySelector('.gallery-fullscreen'),'Fullscreen toggle missing');
  doc.querySelector('video').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(title(),'first.webm','Gallery shortcuts must not override focused video controls');
  doc.querySelector('.gallery-next').click();
  await until(()=>title()==='second.webm','Next arrow did not advance to second.webm');
  doc.querySelector('#preview-dialog').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  await until(()=>title()==='first.webm','ArrowRight did not wrap to first.webm');
  doc.querySelector('#preview-dialog').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  await until(()=>title()==='second.webm','ArrowLeft did not step back to second.webm');
  doc.querySelector('#preview-close').click();
  await until(()=>!doc.querySelector('#preview-dialog[open]'),'Preview did not close');
});
test('select all selects the current visible entries',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-selection-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('selection test passphrase'));
  await vault.upload(null,'first.txt','text/plain',[Buffer.from('first')]);
  await vault.upload(null,'second.txt','text/plain',[Buffer.from('second')]);
  const app=await startServer(vault);
  const browser=new Browser({settings:{enableJavaScriptEvaluation:true,suppressInsecureJavaScriptEnvironmentWarning:true,fetch:{requestHeaders:[{headers:{Origin:app.origin}}]}}});
  t.after(async()=>{await browser.close();await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const page=browser.newPage();await page.goto(app.launchUrl);
  const doc=page.mainFrame.window.document;
  await until(()=>doc.querySelectorAll('.file-row').length===2,'Entries did not load');
  doc.querySelector('#select-all').click();
  assert.equal(doc.querySelector('#selection-count').textContent,'2 selected');
  assert.equal(doc.querySelectorAll('.entry-select:checked').length,2);
  assert.equal(doc.querySelector('#selection-actions').hidden,false);
});
test('bulk move sends selected visible entries to the chosen folder',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-bulk-move-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('bulk move test passphrase'));
  const destination=await vault.mkdir(null,'Destination');
  await vault.upload(null,'first.txt','text/plain',[Buffer.from('first')]);
  await vault.upload(null,'second.txt','text/plain',[Buffer.from('second')]);
  const app=await startServer(vault);
  const browser=new Browser({settings:{enableJavaScriptEvaluation:true,suppressInsecureJavaScriptEnvironmentWarning:true,fetch:{requestHeaders:[{headers:{Origin:app.origin}}]}}});
  t.after(async()=>{await browser.close();await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const page=browser.newPage();await page.goto(app.launchUrl);
  const window=page.mainFrame.window,doc=window.document;
  await until(()=>doc.querySelectorAll('.file-row').length===3,'Entries did not load');
  for(const name of ['first.txt','second.txt']){[...doc.querySelectorAll('.file-row')].find(row=>row.textContent.includes(name)).querySelector('.entry-select').click();}
  doc.querySelector('#bulk-move').click();
  doc.querySelector('#destination').value=destination.id;
  doc.querySelector('#action-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>doc.querySelectorAll('.file-row').length===1,'Selected files were not moved');
  assert.deepEqual(vault.list(destination.id).map(entry=>entry.name).sort(),['first.txt','second.txt']);
});
test('bulk delete warns when a selected folder recursively deletes its child',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-bulk-delete-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('bulk delete test passphrase'));
  const parent=await vault.mkdir(null,'Parent');
  await vault.mkdir(parent.id,'Child');
  const app=await startServer(vault);
  const browser=new Browser({settings:{enableJavaScriptEvaluation:true,suppressInsecureJavaScriptEnvironmentWarning:true,fetch:{requestHeaders:[{headers:{Origin:app.origin}}]}}});
  t.after(async()=>{await browser.close();await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const page=browser.newPage();await page.goto(app.launchUrl);
  const window=page.mainFrame.window,doc=window.document;
  await until(()=>doc.querySelectorAll('.file-row').length===1,'Entries did not load');
  doc.querySelector('#select-all').click();doc.querySelector('#bulk-delete').click();
  assert.match(doc.querySelector('#dialog-description').textContent,/1 selected/i);
  assert.match(doc.querySelector('#dialog-description').textContent,/folder.*everything inside/i);
  doc.querySelector('#action-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>doc.querySelectorAll('.file-row').length===0,'Selected folders were not deleted');
});
test('bulk delete removes select-all search results that include nested entries',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-bulk-delete-search-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('bulk delete search passphrase'));
  const parent=await vault.mkdir(null,'Project'),child=await vault.mkdir(parent.id,'Project notes');
  await vault.upload(child.id,'Project secret.txt','text/plain',[Buffer.from('secret')]);
  await vault.upload(null,'Project plan.txt','text/plain',[Buffer.from('plan')]);
  const app=await startServer(vault);
  const browser=new Browser({settings:{enableJavaScriptEvaluation:true,suppressInsecureJavaScriptEnvironmentWarning:true,fetch:{requestHeaders:[{headers:{Origin:app.origin}}]}}});
  t.after(async()=>{await browser.close();await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const page=browser.newPage();await page.goto(app.launchUrl);
  const window=page.mainFrame.window,doc=window.document;
  await until(()=>doc.querySelectorAll('.file-row').length===2,'Root entries did not load');
  const search=doc.querySelector('#search');search.value='Project';search.dispatchEvent(new window.Event('input'));
  await until(()=>doc.querySelectorAll('.file-row').length===4,'Nested search results did not load');
  doc.querySelector('#select-all').click();doc.querySelector('#bulk-delete').click();
  assert.match(doc.querySelector('#dialog-description').textContent,/4 selected/i);
  doc.querySelector('#action-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>doc.querySelectorAll('.file-row').length===0,'Selected search results were not deleted');
  assert.equal(doc.querySelector('#notice').textContent.includes('Not found'),false);
  assert.equal(vault.list(null,'',{recursive:true}).length,0);
});
test('selection clears when the browser reloads',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-selection-reload-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('selection reload test passphrase'));
  await vault.upload(null,'first.txt','text/plain',[Buffer.from('first')]);
  const app=await startServer(vault);
  const browser=new Browser({settings:{enableJavaScriptEvaluation:true,suppressInsecureJavaScriptEnvironmentWarning:true,fetch:{requestHeaders:[{headers:{Origin:app.origin}}]}}});
  t.after(async()=>{await browser.close();await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const page=browser.newPage();await page.goto(app.launchUrl);
  let doc=page.mainFrame.window.document;
  await until(()=>doc.querySelectorAll('.file-row').length===1,'Entries did not load');
  doc.querySelector('#select-all').click();
  assert.equal(doc.querySelector('#selection-count').textContent,'1 selected');
  await page.goto(`${app.origin}/?reload=1`);doc=page.mainFrame.window.document;
  await until(()=>doc.querySelectorAll('.file-row').length===1,'Entries did not reload');
  assert.equal(doc.querySelector('#selection-actions').hidden,true);
  assert.equal(doc.querySelectorAll('.entry-select:checked').length,0);
});

test('security controls confirm passkey disable and roll back a failed change',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-security-disable-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('security disable passphrase'));
  let attempts=0;
  vault.passkeyStatus=()=>({enabled:true});
  vault.disablePasskey=async()=>{attempts++;if(attempts===1)throw new Error('device refused');};
  const app=await startServer(vault);
  const browser=new Browser({settings:{enableJavaScriptEvaluation:true,suppressInsecureJavaScriptEnvironmentWarning:true,fetch:{requestHeaders:[{headers:{Origin:app.origin}}]}}});
  t.after(async()=>{await browser.close();await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const page=browser.newPage();await page.goto(app.launchUrl);
  const window=page.mainFrame.window,doc=window.document;
  await until(()=>doc.querySelector('#passkey-switch')?.checked===true,'Passkey status did not load');

  const passkeySwitch=doc.querySelector('#passkey-switch');
  passkeySwitch.click();
  assert.equal(doc.querySelector('#action-dialog').open,true,'Disable confirmation did not open');
  assert.match(doc.querySelector('#dialog-description').textContent,/password.*recovery file/i);
  doc.querySelector('#action-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>attempts===1&&passkeySwitch.checked,'Failed disable did not restore the switch');
  assert.match(doc.querySelector('#notice').textContent,/could not disable passkey/i);
  doc.querySelector('#dialog-cancel').click();

  passkeySwitch.click();
  doc.querySelector('#action-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>attempts===2&&!doc.querySelector('#action-dialog').open,'Confirmed disable did not complete');
  assert.equal(passkeySwitch.checked,false);
  assert.match(doc.querySelector('#passkey-status').textContent,/off/i);
});

test('security controls enroll a fresh passkey and download a replacement recovery image',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-security-enable-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('security enable passphrase'));
  const paths=[],image=Buffer.from('\x89PNG replacement');
  vault.passkeyStatus=()=>({enabled:false});
  vault.setPasskey=async()=>{};
  vault.createRecoveryImage=async()=>image;
  const service={
    async beginRegistration(){paths.push('options');if(paths.length===1)throw new Error('unavailable');return {challenge:'AQ',rp:{id:'localhost',name:'Vault'},user:{id:'Ag',name:'vault',displayName:'Vault'}};},
    async verifyRegistration(){paths.push('verify');return {challenge:'Aw',allowCredentials:[{id:'BA',type:'public-key'}]};},
    async verifyRegistrationConfirmation(){paths.push('confirm');return {credentialId:'BA',publicKey:'BQ',counter:0,transports:['internal'],prfSalt:'Bg',prfOutput:Buffer.alloc(32,7),newCounter:0};}
  };
  const app=await startServer(vault,{passkeyService:service});
  const browser=new Browser({settings:{enableJavaScriptEvaluation:true,suppressInsecureJavaScriptEnvironmentWarning:true,fetch:{requestHeaders:[{headers:{Origin:app.origin}}]}}});
  t.after(async()=>{await browser.close();await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const page=browser.newPage();await page.goto(app.launchUrl);
  const window=page.mainFrame.window,doc=window.document;
  await until(()=>doc.querySelector('#passkey-switch')?.disabled===false,'Passkey status did not load');
  window.PublicKeyCredential=class {};
  const result=Uint8Array.from({length:32},(_,index)=>index);
  const created={id:'new',rawId:Uint8Array.of(1).buffer,type:'public-key',response:{attestationObject:Uint8Array.of(2).buffer,clientDataJSON:Uint8Array.of(3).buffer,getTransports:()=>['internal']}};
  const confirmed={id:'new',rawId:Uint8Array.of(1).buffer,type:'public-key',response:{authenticatorData:Uint8Array.of(4).buffer,clientDataJSON:Uint8Array.of(5).buffer,signature:Uint8Array.of(6).buffer,userHandle:null},getClientExtensionResults:()=>({prf:{results:{first:result.buffer}}})};
  Object.defineProperty(window.navigator,'credentials',{configurable:true,value:{create:async()=>created,get:async()=>confirmed}});

  const passkeySwitch=doc.querySelector('#passkey-switch');
  passkeySwitch.click();
  await until(()=>paths.length===1&&!passkeySwitch.disabled,'Failed enrollment did not complete');
  assert.equal(passkeySwitch.checked,false,'Failed enrollment did not restore the switch');
  assert.match(doc.querySelector('#notice').textContent,/could not enable passkey/i);
  passkeySwitch.click();
  await until(()=>paths.length===4&&passkeySwitch.checked,()=>`Fresh passkey enrollment did not complete: ${paths.join(',')} ${doc.querySelector('#notice').textContent}`);
  assert.deepEqual(paths,['options','options','verify','confirm']);
  assert.match(doc.querySelector('#passkey-status').textContent,/on/i);

  const downloads=[];
  window.URL.createObjectURL=blob=>{downloads.push({blob});return 'blob:recovery';};
  window.URL.revokeObjectURL=url=>{downloads.at(-1).revoked=url;};
  window.HTMLAnchorElement.prototype.click=function(){downloads.at(-1).name=this.download;downloads.at(-1).href=this.href;};
  doc.querySelector('#generate-recovery').click();
  await until(()=>downloads.length===1&&downloads[0].revoked,'Recovery file was not downloaded and revoked');
  assert.equal(downloads[0].blob.type,'image/png');
  assert.equal(downloads[0].name,'Vault recovery file.png');
  assert.equal(downloads[0].href,'blob:recovery');
  assert.equal(downloads[0].revoked,'blob:recovery');
  assert.match(doc.querySelector('#generate-recovery').textContent,/replace/i);
});

test('bulk Download requests a ticket for visible selection and navigates a hidden anchor',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'secretcli-bulk-download-'));
  const vault=await createVault(join(root,'vault'),Buffer.from('bulk download passphrase'));
  await vault.upload(null,'first.txt','text/plain',[Buffer.from('first')]);
  await vault.upload(null,'second.txt','text/plain',[Buffer.from('second')]);
  const app=await startServer(vault);
  const browser=new Browser({settings:{enableJavaScriptEvaluation:true,suppressInsecureJavaScriptEnvironmentWarning:true,fetch:{requestHeaders:[{headers:{Origin:app.origin}}]}}});
  t.after(async()=>{await browser.close();await app.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const page=browser.newPage();await page.goto(app.launchUrl);
  const window=page.mainFrame.window,doc=window.document;
  await until(()=>doc.querySelectorAll('.file-row').length===2,'Entries did not load');
  assert.equal(doc.querySelector('#bulk-download').disabled,true);
  const nativeFetch=window.fetch.bind(window),requests=[];
  window.fetch=async(path,init)=>{if(path==='/api/downloads'){requests.push(JSON.parse(init.body));return {ok:true,status:201,json:async()=>({url:'/api/downloads/token'})};}return nativeFetch(path,init);};
  let navigatedTo,anchorHidden;
  window.HTMLAnchorElement.prototype.click=function(){navigatedTo=this.getAttribute('href');anchorHidden=this.hidden;};
  doc.querySelector('#select-all').click();doc.querySelector('#bulk-download').click();
  await until(()=>navigatedTo,'Download ticket did not navigate');
  assert.deepEqual(requests[0].ids.sort(),vault.list(null).map(entry=>entry.id).sort());
  assert.equal(navigatedTo,'/api/downloads/token');
  assert.equal(anchorHidden,true);
  assert.equal(doc.querySelector('#selection-count').textContent,'2 selected');

  window.fetch=async(path,init)=>path==='/api/downloads'?{ok:false,status:500,json:async()=>({error:'Ticket service unavailable'})}:nativeFetch(path,init);
  navigatedTo=undefined;doc.querySelector('#bulk-download').click();
  await until(()=>doc.querySelector('#notice').textContent.includes('Ticket service unavailable'),'Ticket failure notice missing');
  assert.equal(navigatedTo,undefined);
  assert.equal(doc.querySelector('#bulk-download').disabled,false);
});
