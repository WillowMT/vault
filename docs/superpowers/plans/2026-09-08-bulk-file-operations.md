# Bulk File Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select visible files and folders, then move or permanently delete the entire selection atomically.

**Architecture:** The vault owns prevalidation, catalog mutation, recursive delete expansion, and object cleanup. The HTTP server exposes authenticated, CSRF-protected bulk routes. The browser owns transient selection state and renders checkboxes plus a contextual action bar that uses the existing dialog and folder-picker conventions.

**Tech Stack:** Node.js 24, ESM JavaScript, encrypted vault catalog, Node built-in test runner, Happy DOM.

## Global Constraints

- Use ESM imports, explicit `.js` extensions, two-space indentation, single quotes, and semicolons.
- Render filenames with `textContent`, never HTML interpolation.
- Preserve loopback binding, encrypted metadata, authenticated sessions, and CSRF protection.
- Select-all applies only to currently visible entries after the active folder, category, query, and sort rules.
- Bulk move and delete reject invalid full selections without catalog changes.
- Bulk delete is irreversible and warns when selected folders recursively delete contents.

---

### Task 1: Atomic Vault Bulk Mutations

**Files:**
- Modify: `src/vault/vault.js:45-73`
- Modify: `test/vault.test.js:36-48`

**Interfaces:**
- Produces: `vault.moveMany(ids, parentId): Promise<number>` and `vault.removeMany(ids): Promise<number>`.
- Consumes: the existing `mutate`, `find`, `parent`, `unique`, and `discard` closures inside `createVault()`.

- [ ] **Step 1: Write failing vault tests**

```javascript
test('bulk vault mutations move selected entries and reject invalid selections atomically',async t=>{
  const {vault}=await fixture(t);const a=await vault.mkdir(null,'A'),b=await vault.mkdir(null,'B');
  const one=await vault.upload(a.id,'one.txt','text/plain',[Buffer.from('one')]);
  const two=await vault.upload(a.id,'two.txt','text/plain',[Buffer.from('two')]);
  assert.equal(await vault.moveMany([one.id,two.id],b.id),2);
  assert.deepEqual(vault.list(b.id).map(entry=>entry.name).sort(),['one.txt','two.txt']);
  await assert.rejects(vault.moveMany([one.id,'missing'],null),/not found/i);
  assert.deepEqual(vault.list(b.id).map(entry=>entry.name).sort(),['one.txt','two.txt']);
});

test('bulk vault delete collapses nested selected folders',async t=>{
  const {vault}=await fixture(t);const parent=await vault.mkdir(null,'Parent'),child=await vault.mkdir(parent.id,'Child');
  const file=await vault.upload(child.id,'secret.txt','text/plain',[Buffer.from('secret')]);
  assert.equal(await vault.removeMany([parent.id,child.id]),2);
  assert.throws(()=>vault.stat(file.id),/not found/i);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/vault.test.js`

Expected: FAIL with `vault.moveMany is not a function`.

- [ ] **Step 3: Implement vault methods**

```javascript
moveMany(ids,parentId){return mutate(next=>{
  const selected=validateIds(ids);parent(parentId);
  for(const entry of selected){unique(parentId,entry.name,entry.id);for(let id=parentId;id!==null;id=find(id).parentId)if(id===entry.id)throw new VaultError('Cannot move a folder into itself or a descendant');}
  for(const entry of selected)next.find(item=>item.id===entry.id).parentId=parentId;
  return selected.length;
});},
async removeMany(ids){
  const objects=await mutate(next=>{
    const selected=validateIds(ids),removed=new Set(selected.map(entry=>entry.id));let grew=true;
    while(grew){grew=false;for(const entry of next)if(removed.has(entry.parentId)&&!removed.has(entry.id)){removed.add(entry.id);grew=true;}}
    const objects=next.filter(entry=>removed.has(entry.id)&&entry.kind==='file').map(entry=>entry.objectId);
    for(let index=next.length-1;index>=0;index--)if(removed.has(next[index].id))next.splice(index,1);
    return objects;
  });
  await Promise.all(objects.map(discard));return ids.length;
}
```

Define `validateIds(ids)` beside `find`: require a non-empty array of unique string IDs and resolve every entry before mutation. For moves, also reject collisions among selected entries with identical names when their target folder is shared.

- [ ] **Step 4: Run vault tests to verify pass**

Run: `node --test test/vault.test.js`

Expected: PASS.

- [ ] **Step 5: Commit vault support**

```bash
git add src/vault/vault.js test/vault.test.js
git commit -m "add atomic bulk vault operations"
```

### Task 2: Bulk HTTP Routes

**Files:**
- Modify: `src/server/server.js:44-55`
- Modify: `test/server.test.js:17-51`

**Interfaces:**
- Consumes: `vault.moveMany(ids,parentId)` and `vault.removeMany(ids)`.
- Produces: `POST /api/entries/bulk-move` with `{ids,parentId}` and `{moved}`, plus `POST /api/entries/bulk-delete` with `{ids}` and `{deleted}`.

- [ ] **Step 1: Write failing authenticated route tests**

```javascript
const second=await vault.upload(null,'second.txt','text/plain',[Buffer.from('two')]);
const moved=await fetch(url('/api/entries/bulk-move'),{method:'POST',headers,body:JSON.stringify({ids:[file.id,second.id],parentId:folder.id})});
assert.equal(moved.status,200);assert.deepEqual(await moved.json(),{moved:2});
const deleted=await fetch(url('/api/entries/bulk-delete'),{method:'POST',headers,body:JSON.stringify({ids:[file.id,second.id]})});
assert.equal(deleted.status,200);assert.deepEqual(await deleted.json(),{deleted:2});
```

Also assert a request missing CSRF is `403` and an empty `ids` array is a `400` error.

- [ ] **Step 2: Run test to verify failure**

Run: `node --test test/server.test.js`

Expected: FAIL with a `404` response for `/api/entries/bulk-move`.

- [ ] **Step 3: Implement routes**

```javascript
if(req.method==='POST'&&path==='/api/entries/bulk-move'){
  const value=await body(req);json(res,200,{moved:await vault.moveMany(value.ids,value.parentId??null)});return;
}
if(req.method==='POST'&&path==='/api/entries/bulk-delete'){
  const value=await body(req);json(res,200,{deleted:await vault.removeMany(value.ids)});return;
}
```

- [ ] **Step 4: Run server tests to verify pass**

Run: `node --test test/server.test.js`

Expected: PASS.

- [ ] **Step 5: Commit HTTP routes**

```bash
git add src/server/server.js test/server.test.js
git commit -m "serve bulk file operations"
```

### Task 3: Selection Controls and Bulk Dialogs

**Files:**
- Modify: `web/index.html:32`
- Modify: `web/styles.css`
- Modify: `web/app.js:5-78`
- Modify: `test/web.test.js`

**Interfaces:**
- Consumes: `request('/api/entries/bulk-move',{method:'POST',body:{ids,parentId}})` and `request('/api/entries/bulk-delete',{method:'POST',body:{ids}})`.
- Produces: toolbar checkbox `#select-all`, live selection bar `#selection-actions`, and `Set`-backed browser selection state.

- [ ] **Step 1: Write failing browser integration test**

```javascript
const selectAll=doc.querySelector('#select-all');selectAll.click();
assert.equal(doc.querySelector('#selection-count').textContent,'2 selected');
doc.querySelector('#bulk-move').click();
doc.querySelector('#destination').value=folder.id;doc.querySelector('#action-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
await until(()=>doc.querySelectorAll('.file-row').length===0,'Selected files were not moved');
```

Create two files and a destination folder. Add a second test that selects a folder plus child, opens `#bulk-delete`, checks warning text, submits, and verifies the selection bar is hidden after reload.

- [ ] **Step 2: Run browser test to verify failure**

Run: `node --test test/web.test.js`

Expected: FAIL because `#select-all` does not exist.

- [ ] **Step 3: Implement selection state and markup**

```javascript
let selected=new Set(),visibleEntries=[];
function clearSelection(){selected.clear();}
function selectedEntries(){return visibleEntries.filter(entry=>selected.has(entry.id));}
```

Add `#select-all` to `.file-toolbar`, `#selection-actions` containing `#selection-count`, `#bulk-move`, `#bulk-delete`, and `#clear-selection`, and a checkbox in each rendered file row/card. Set `visibleEntries=filtered` in `render()`. Clear `selected` at the start of `load()`, `navigate()`, category/search/sort/view handlers, and `lockView()`. Disable move/delete while no entries are selected.

Reuse the destination select construction from `move(entry)`, but exclude every selected folder and its descendants. Bulk delete opens `dialog()` with `danger:true`; its description includes the selected count and folder warning. On successful request, clear selection, show a notice, and call `load()` through the existing dialog-submit path.

- [ ] **Step 4: Style controls accessibly**

```css
.selection-actions{display:flex;align-items:center;gap:8px}
.entry-select{accent-color:var(--mint)}
```

Keep the action bar within the existing file toolbar; ensure it wraps below the item count on narrow screens and preserves visible keyboard focus.

- [ ] **Step 5: Run browser and full tests**

Run: `node --test test/web.test.js && npm test`

Expected: all tests PASS.

- [ ] **Step 6: Commit browser feature**

```bash
git add web/index.html web/styles.css web/app.js test/web.test.js
git commit -m "select and manage multiple vault entries"
```
