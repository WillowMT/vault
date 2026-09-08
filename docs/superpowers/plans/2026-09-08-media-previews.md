# Media Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inline PDF viewing, text/markdown/code viewing, a voice-note audio player, and client-side grid thumbnails for files in the vault's browser UI.

**Architecture:** One new frontend module (`web/thumbnails.js`) owns thumbnail generation/caching/revocation; `web/preview.js` gains per-type renderers (PDF iframe, text pane, voice-note player); `app.js` asks for thumbnails in grid view; the server adds a few MIME types to the inline allowlist and relaxes CSP `frame-src` to `'self'`. No server route changes — the content endpoint already streams with byte ranges.

**Tech Stack:** Node.js built-in test runner (`node:test`, `node:assert/strict`), Happy DOM for UI tests, browser-native ESM frontend (no build pipeline, no new dependencies).

## Global Constraints

- Node.js 24+ (`engines` in package.json). macOS target.
- ESM imports with explicit `.js` extensions; two-space indent; single quotes; semicolons (AGENTS.md).
- Render user-supplied filenames and file text with `textContent` / `createElement` only — never `innerHTML` (AGENTS.md).
- No new npm dependencies; no frontend build pipeline; no CDN scripts.
- Preserve `Cache-Control: no-store` on all responses, loopback binding, and encrypted metadata (AGENTS.md).
- Never write decrypted previews or thumbnails to disk (docs/superpowers/specs/2026-09-08-secretcli-design.md).
- `object-src 'none'`, `script-src 'self'`, `img-src 'self' blob:` stay unchanged in the CSP; only `frame-src` changes to `'self'`.
- `image/svg+xml` and `text/html` remain excluded from inline serving.
- DOM tests do not verify rendering or media codecs (AGENTS.md) — test logic and DOM structure, not pixels.
- This directory has **no git repository** — there are no commit steps; each task ends with green tests instead.
- Run the full suite with `npm test` from the repo root before considering a task done.

**Spec:** `docs/superpowers/specs/2026-09-08-media-previews-design.md`

---

### Task 1: Server inline allowlist + CSP frame-src

**Files:**
- Modify: `src/server/security.js:7` (CSP string), `src/server/security.js:15` (inline set)
- Test: `test/server.test.js` (append new test)

**Interfaces:**
- Consumes: `vault.upload(parentId, name, mime, stream)` (existing), `startServer(vault)` → `app.origin`, `app.close()` (existing).
- Produces: `contentType('application/pdf')` → `'application/pdf'`, `contentType('text/plain')` → `'text/plain'`, `contentType('text/markdown')` → `'text/markdown'` (everything else unchanged). CSP header on every response contains `frame-src 'self'`.

- [ ] **Step 1: Write the failing test**

Append to `test/server.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL — PDF content-type is `application/octet-stream` and disposition is `attachment`; CSP contains `frame-src 'none'`.

- [ ] **Step 3: Implement**

In `src/server/security.js`, line 7, change `frame-src 'none'` to `frame-src 'self'` inside the CSP string (leave every other directive untouched):

```javascript
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
```

Line 15, add three types to the `inline` set (keep `image/svg+xml` and `text/html` absent):

```javascript
const inline=new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp','audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/webm','audio/flac','video/mp4','video/webm','video/ogg','video/quicktime','application/pdf','text/plain','text/markdown']);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS, including the pre-existing `text/html` → `application/octet-stream` + attachment test.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all files PASS.

---

### Task 2: Thumbnail module `web/thumbnails.js`

**Files:**
- Create: `web/thumbnails.js`
- Test: `test/thumbnails.test.js` (new file)

**Interfaces:**
- Consumes: `fileCategory` from `./preview.js` (existing export).
- Produces (used by Tasks 3–4):
  - `attachThumbnail(tile, entry)` — appends the fallback icon to `tile`, then asynchronously swaps in an `<img>` with the blob URL when ready.
  - `thumbnailFor(entry)` → `Promise<string|null>` — cached blob URL for the entry, or `null`.
  - `setThumbnailGenerator(fn)` — test hook; `fn(entry)` → `Promise<string|null>`.
  - `revokeThumbnails()` — revokes every cached blob URL and clears state (called on vault lock).

- [ ] **Step 1: Write the failing test**

Create `test/thumbnails.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {thumbnailFor,setThumbnailGenerator,revokeThumbnails} from '../web/thumbnails.js';

test('thumbnail cache returns one URL per entry and revokes on lock',async()=>{
  let calls=0;
  setThumbnailGenerator(async entry=>{calls++;return `blob:fake-${entry.id}`;});
  const entry={id:'a'.repeat(36),size:10,kind:'file',mime:'image/png',name:'a.png'};
  assert.equal(await thumbnailFor(entry),`blob:fake-${'a'.repeat(36)}`);
  assert.equal(await thumbnailFor(entry),`blob:fake-${'a'.repeat(36)}`);
  assert.equal(calls,1);
  const other={...entry,id:'b'.repeat(36)};
  assert.equal(await thumbnailFor(other),`blob:fake-${'b'.repeat(36)}`);
  assert.equal(calls,2);
  revokeThumbnails();
  assert.equal(await thumbnailFor(entry),`blob:fake-${'a'.repeat(36)}`);
  assert.equal(calls,3);
  setThumbnailGenerator(null);
});
```

Note: `web/thumbnails.js` must not touch `document` at module load (Node imports it here), only inside functions.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/thumbnails.test.js`
Expected: FAIL — `Cannot find module '../web/thumbnails.js'`.

- [ ] **Step 3: Create `web/thumbnails.js`**

```javascript
import {fileCategory,fileIcon} from './preview.js';
const MAX=320,TIMEOUT=10000,LIMIT=3;
const cache=new Map(),pending=new Map(),jobs=new Map();
let queue=[],active=0,override=null,observer=null;
export function setThumbnailGenerator(fn){override=fn;}
function withTimeout(promise){return Promise.race([promise,new Promise(resolve=>setTimeout(()=>resolve(null),TIMEOUT))]);}
function drawToBlob(source,width,height){
  const canvas=document.createElement('canvas'),scale=Math.min(1,MAX/Math.max(width,height,1));
  canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
  const context=canvas.getContext('2d');if(!context)return Promise.resolve(null);
  context.drawImage(source,0,0,canvas.width,canvas.height);
  return new Promise(resolve=>{canvas.toBlob(blob=>resolve(blob?URL.createObjectURL(blob):null),'image/jpeg',0.75);});
}
function loadImage(url){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=url;});}
function loadVideoFrame(url){return new Promise((resolve,reject)=>{
  const video=document.createElement('video');video.muted=true;video.preload='metadata';
  video.onloadedmetadata=()=>{video.currentTime=Math.min(1,(video.duration||2)*0.1);};
  video.onseeked=()=>resolve(video);video.onerror=reject;video.src=url;});}
function defaultGenerator(entry){return fileCategory(entry)==='video'?loadVideoFrame(`/api/files/${entry.id}/content`).then(video=>drawToBlob(video,video.videoWidth,video.videoHeight)):loadImage(`/api/files/${entry.id}/content`).then(img=>drawToBlob(img,img.naturalWidth,img.naturalHeight));}
function schedule(job){return new Promise(resolve=>{queue.push({job,resolve});pump();});}
function pump(){while(active<LIMIT&&queue.length){active++;const {job,resolve}=queue.shift();job().then(value=>resolve(value)).finally(()=>{active--;pump();});}}
export function thumbnailFor(entry){
  const key=`${entry.id}:${entry.size}`;
  if(cache.has(key))return Promise.resolve(cache.get(key));
  if(pending.has(key))return pending.get(key);
  const promise=schedule(()=>withTimeout((override||defaultGenerator)(entry)))
    .then(url=>{pending.delete(key);if(url){cache.set(key,url);return url;}return null;})
    .catch(()=>{pending.delete(key);return null;});
  pending.set(key,promise);return promise;
}
function ensureObserver(){
  if(observer||typeof IntersectionObserver==='undefined')return observer;
  observer=new IntersectionObserver(records=>{
    for(const record of records)if(record.isIntersecting){observer.unobserve(record.target);const run=jobs.get(record.target);if(run){jobs.delete(record.target);run();}}
  },{rootMargin:'200px'});
  return observer;
}
function apply(tile,url){const img=document.createElement('img');img.alt='';img.src=url;tile.replaceChildren(img);}
export function attachThumbnail(tile,entry){
  tile.append(fileIcon(entry));
  if(cache.has(`${entry.id}:${entry.size}`)){apply(tile,cache.get(`${entry.id}:${entry.size}`));return;}
  const run=()=>{thumbnailFor(entry).then(url=>{if(url&&tile.isConnected)apply(tile,url);}).catch(()=>{});};
  const obs=ensureObserver();
  if(obs){jobs.set(tile,run);obs.observe(tile);}else run();
}
export function revokeThumbnails(){
  for(const url of cache.values())URL.revokeObjectURL(url);
  cache.clear();pending.clear();jobs.clear();queue=[];active=0;
  observer?.disconnect();observer=null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/thumbnails.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all files PASS.

---

### Task 3: Preview renderers — PDF iframe, text pane, voice-note player

**Files:**
- Modify: `web/preview.js`
- Test: `test/web.test.js` (append new test)

**Interfaces:**
- Consumes: existing `showPreview(entry)` / `clearPreview()` / `fileIcon(entry)`; content URL pattern `/api/files/<id>/content` (authenticated by session cookie).
- Produces: `showPreview` dispatch rules used by `app.js` unchanged (`showPreview(entry)`). New DOM: `.pdf-frame` iframe, `.text-preview` pre, `.voice-note` wrapper with `.voice-speed` button for audio entries. Task 5 styles these classes.

- [ ] **Step 1: Write the failing test**

Append to `test/web.test.js`:

```javascript
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
  await open('notes.txt');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/web.test.js`
Expected: FAIL — PDF shows the unsupported-download panel (no `iframe.pdf-frame`), text shows nothing, audio has no `.voice-note`.

- [ ] **Step 3: Implement in `web/preview.js`**

Add below `fileIcon` (module scope):

```javascript
function isTextEntry(entry){return (entry.mime?.startsWith('text/')||/\.(txt|md|js|ts|json|css|sh|py)$/i.test(entry.name||''))&&entry.mime!=='text/html';}
function textPreview(content,entry,url){
  const pre=document.createElement('pre');pre.className='text-preview';content.append(pre);
  fetch(url,{credentials:'same-origin',cache:'no-store'}).then(async response=>{
    if(!response.ok){pre.textContent='Could not load this file. You can still download it.';return;}
    const text=await response.text();
    pre.textContent=text.length>1048576?`${text.slice(0,1048576)}\n\n… (truncated)`:text;
  }).catch(()=>{pre.textContent='Could not load this file. You can still download it.';});
}
function voiceNote(media){
  const wrap=document.createElement('div');wrap.className='voice-note';
  const head=document.createElement('div');head.className='voice-note-head';
  const label=document.createElement('span');label.className='voice-note-label';label.textContent='Voice note';
  const speed=document.createElement('button');speed.type='button';speed.className='voice-speed';speed.textContent='1×';
  const rates=[1,1.25,1.5,2];let index=0;
  speed.onclick=()=>{index=(index+1)%rates.length;media.playbackRate=rates[index];speed.textContent=`${rates[index]}×`;};
  head.append(label,speed);wrap.append(head,media);return wrap;
}
```

In `showPreview`, replace the `if(supported.has(entry.mime)){…}else{…}` block with a four-way dispatch (keep the existing `supported` Set and `kind` just above):

```javascript
  if(entry.mime==='application/pdf'){
    const frame=document.createElement('iframe');frame.className='pdf-frame';frame.src=url;frame.title=entry.name;content.append(frame);
  }else if(isTextEntry(entry)){
    textPreview(content,entry,url);
  }else if(supported.has(entry.mime)){
    const media=document.createElement(kind==='image'?'img':kind==='video'?'video':'audio');media.src=url;
    if(kind==='image')media.alt=entry.name;else{media.controls=true;media.preload='metadata';}
    media.onerror=()=>{const p=document.createElement('p');p.textContent='This browser cannot preview this format. You can still download the original.';content.replaceChildren(p);};
    content.append(kind==='audio'?voiceNote(media):media);
  }else{
    const panel=document.createElement('div');panel.className='unsupported-preview';panel.append(fileIcon(entry));const p=document.createElement('p');p.textContent='This file is safely stored. Download it to open in its own app.';panel.append(p);content.append(panel);
  }
```

`clearPreview` needs no change: `replaceChildren` removes the iframe/pre, and its `audio,video` pause loop already covers the audio element inside `.voice-note`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/web.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all files PASS.

---

### Task 4: Grid thumbnails in `app.js` + asset registration

**Files:**
- Modify: `src/server/server.js:9` (assets map), `web/app.js:2` (imports), `web/app.js` `lockView()` and `render()`
- Test: `test/web.test.js` (extend existing grid assertion)

**Interfaces:**
- Consumes: `attachThumbnail(tile, entry)`, `revokeThumbnails()` from `web/thumbnails.js` (Task 2); `fileCategory(entry)` already imported in `app.js`.
- Produces: grid cards for image/video files render a `.file-thumb` tile (falls back to the glyph icon when generation fails); lock clears cached blob URLs.

- [ ] **Step 1: Write the failing test**

In `test/web.test.js`, immediately after the line `doc.querySelector('#grid-view').click();assert.ok(doc.querySelector('.file-card'));` (line 34), add:

```javascript
  const card=[...doc.querySelectorAll('.file-card')].find(n=>n.textContent.includes('renamed.png'));
  assert.ok(card?.querySelector('.file-thumb .file-icon'),'Grid card lacks thumbnail tile with icon fallback');
```

(Real image decoding is not verified in DOM tests per AGENTS.md; the tile with icon fallback is the observable contract.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/web.test.js`
Expected: FAIL — cards contain only `.file-icon`, no `.file-thumb`.

- [ ] **Step 3: Implement**

In `src/server/server.js`, extend the assets map (line 9):

```javascript
const assets=new Map([['/','index.html'],['/styles.css','styles.css'],['/app.js','app.js'],['/api.js','api.js'],['/preview.js','preview.js'],['/thumbnails.js','thumbnails.js']]);
```

In `web/app.js`, add below the existing `./preview.js` import (line 2):

```javascript
import {attachThumbnail,revokeThumbnails} from './thumbnails.js';
```

Add a helper above `render()`:

```javascript
function thumbnailTile(entry){const tile=element('span',undefined,'file-thumb');attachThumbnail(tile,entry);return tile;}
```

In `lockView()`, add `revokeThumbnails();` right after `clearPreview();`.

In `render()`, replace only the `name.append(...)` part of line 49 (the `const name=element(...)` line stays exactly as it is). Replace:

```javascript
name.append(fileIcon(entry),element('span',entry.name,'file-name-text'));
```

with:

```javascript
const thumb=view==='grid'&&entry.kind==='file'&&['image','video'].includes(fileCategory(entry))?thumbnailTile(entry):fileIcon(entry);
name.append(thumb,element('span',entry.name,'file-name-text'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/web.test.js`
Expected: PASS — including the pre-existing "locks and clears on disconnect" assertions (thumbnail state must not leak into `body.textContent`).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all files PASS.

---

### Task 5: Styles for the new preview elements

**Files:**
- Modify: `web/styles.css` (append at end of file)
- Test: none (visual only; existing tests must stay green)

**Interfaces:**
- Consumes: class names produced in Tasks 3–4: `iframe.pdf-frame`, `pre.text-preview`, `.voice-note`, `.voice-note-head`, `.voice-note-label`, `.voice-speed`, `.file-thumb`.
- Produces: layout only; no JS-facing changes.

- [ ] **Step 1: Append the CSS**

Add to the end of `web/styles.css` (matching the file's compact one-rule-per-line style):

```css
#preview-content iframe.pdf-frame{width:100%;height:65vh;border:0;border-radius:8px;background:white}
#preview-content pre.text-preview{align-self:stretch;width:100%;max-height:65vh;overflow:auto;margin:0;padding:18px;border-radius:8px;background:white;color:#25322b;font:12.5px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;text-align:left}
.voice-note{width:100%;max-width:520px;display:flex;flex-direction:column;gap:10px}
.voice-note-head{display:flex;align-items:center;justify-content:space-between}
.voice-note-label{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)}
.voice-speed{border:1px solid var(--line);border-radius:6px;padding:4px 10px;font-size:12px;background:white}
.file-thumb{width:44px;height:44px;border-radius:7px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#e9ede7;flex:none}
.file-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.file-card .file-thumb{width:100%;height:auto;aspect-ratio:1/1;margin-bottom:6px}
@media(max-width:450px){.file-thumb{width:30px;height:30px}}
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all files PASS (CSS is not parsed by tests; this guards against accidental file corruption).

- [ ] **Step 3: Manual smoke test (human-verified)**

Run: `node bin/secretcli.js --vault /tmp/secretcli-preview --no-open` (directory must not exist), open the printed URL, upload a real image, video, PDF, `.txt`, and audio file, then check:

- Grid view shows image/video thumbnails; list view unchanged.
- PDF renders inside the preview dialog iframe.
- `.txt`/`.md`/`.js` files show text; `.html` files still offer download only.
- Audio shows the voice-note player; speed button cycles 1×→1.25×→1.5×→2×.
- Ctrl+C locks the vault; the browser page clears without console errors.

Delete the test vault afterwards: `rm -rf /tmp/secretcli-preview`.

---

## Self-Review

- **Spec coverage:** inline allowlist + CSP (Task 1), thumbnails with cache/revocation/observer/concurrency (Task 2), PDF iframe (Task 3), text/markdown/code with 1 MB cap and no markdown-to-HTML (Task 3), voice-note player with speed cycle (Task 3), grid-only thumbnails with fallbacks (Tasks 2+4), no-store/textContent/SVG-exclusion preserved (all tasks), tests per file (Tasks 1–4), manual codec check (Task 5).
- **Placeholder scan:** none — all code blocks are complete.
- **Type consistency:** `attachThumbnail(tile, entry)` / `thumbnailFor(entry)` / `setThumbnailGenerator(fn)` / `revokeThumbnails()` names match between Tasks 2, 3, and 4; `.file-thumb`, `.voice-speed`, `.text-preview`, `.pdf-frame` names match between Tasks 3/4 and Task 5.
