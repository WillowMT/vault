# Video Gallery Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add wrapping arrow-button and keyboard navigation between video previews in the current browser view.

**Architecture:** `web/app.js` will provide all previewable entries from the current filtered list. `web/preview.js` will select entries with the same category as the opened image or video and reuse its controls, navigation listener, and existing cleanup path.

**Tech Stack:** Browser-native JavaScript, Happy DOM, Node.js built-in test runner.

## Global Constraints

- Use ESM imports with explicit `.js` extensions, two-space indentation, single quotes, and semicolons.
- Render user-supplied filenames with `textContent`, never HTML interpolation.
- Do not add dependencies or change image gallery behavior.
- Keep image and video galleries separate.

---

### Task 1: Test Video Gallery Navigation

**Files:**
- Modify: `test/web.test.js:77-109`

**Interfaces:**
- Consumes: the existing browser test helpers `until`, `createVault`, and `startServer`.
- Produces: an integration regression test for `.gallery-prev`, `.gallery-next`, and dialog `keydown` events on video previews.

- [ ] **Step 1: Write the failing test**

```javascript
test('video preview navigates the gallery with arrows and keyboard',{timeout:20000},async t=>{
  const transfer=new window.DataTransfer();
  transfer.items.add(new window.File(['first'],'first.webm',{type:'video/webm'}));
  transfer.items.add(new window.File(['second'],'second.webm',{type:'video/webm'}));
  input.files=transfer.files;input.dispatchEvent(new window.Event('change'));
  await until(()=>doc.querySelectorAll('.file-row').length===2,'Uploads did not finish');
  await open('first.webm');
  assert.ok(doc.querySelector('.gallery-prev')&&doc.querySelector('.gallery-next'),'Gallery arrows missing');
  doc.querySelector('.gallery-next').click();
  await until(()=>title()==='second.webm','Next arrow did not advance to second.webm');
  doc.querySelector('#preview-dialog').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  await until(()=>title()==='first.webm','ArrowRight did not wrap to first.webm');
  doc.querySelector('#preview-close').click();
  await until(()=>!doc.querySelector('#preview-dialog[open]'),'Preview did not close');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/web.test.js`

Expected: FAIL because video previews do not render gallery arrows.

- [ ] **Step 3: Commit the regression test**

```bash
git add test/web.test.js
git commit -m "test video gallery navigation"
```

### Task 2: Share Gallery Navigation With Videos

**Files:**
- Modify: `web/app.js:47-52`
- Modify: `web/preview.js:30-75`
- Test: `test/web.test.js`

**Interfaces:**
- Consumes: `setGallery(Entry[])` from `web/preview.js` and `fileCategory(entry)`.
- Produces: video previews rendered inside `.gallery-stage` with the same buttons and arrow-key behavior as images.

- [ ] **Step 1: Write minimal implementation**

```javascript
export function setGallery(entries){gallery=entries;}

function galleryEntries(entry){
  return gallery.filter(item=>fileCategory(item)===fileCategory(entry));
}
```

Update `galleryNav()` to obtain its list from `galleryEntries(entry)`, and render a `.gallery-stage` for both `kind==='image'` and `kind==='video'`. In `web/app.js`, pass `filtered.filter(entry=>entry.kind==='file')` to `setGallery()`.

- [ ] **Step 2: Run focused test to verify it passes**

Run: `node --test test/web.test.js`

Expected: PASS, including image and video navigation tests.

- [ ] **Step 3: Run full test suite**

Run: `npm test`

Expected: all tests pass with no failures.

- [ ] **Step 4: Commit the implementation**

```bash
git add web/app.js web/preview.js test/web.test.js
git commit -m "browse videos in preview with arrows and keyboard"
```
