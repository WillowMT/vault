# Selected Items ZIP Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream selected files and folders to the browser as one ZIP while preserving hierarchy and bounded plaintext memory.

**Architecture:** Snapshot selected catalog entries and lease their objects in the vault module, feed lazy decrypted streams into `yazl`, and deliver the archive through a short-lived authenticated download ticket. The browser initiates native navigation so the ZIP writes directly to disk.

**Tech Stack:** Node.js 24 streams, `yazl`, HTTP, browser-native JavaScript, node:test, Happy DOM

## Global Constraints

- No plaintext temporary files and no whole-file or whole-ZIP buffering.
- Preserve nested and empty folders with UTF-8 names.
- Support ZIP64 for Vault's existing 1 TiB file limit.
- Download tickets are session-bound, random, single-use, and expire after 30 seconds.
- A request accepts at most 10,000 selected IDs.

---

### Task 1: Export Snapshot And Object Leases

**Files:**
- Modify: `src/vault/vault.js`
- Modify: `test/vault.test.js`

**Interfaces:**
- Produces: `vault.openExport(ids) -> { entries, release }`.
- Each file entry contains `{kind:'file',path,size,open}` where `open() -> Readable`.
- Each directory entry contains `{kind:'folder',path}`.

- [ ] **Step 1: Write failing traversal tests**

```js
test('openExport preserves selected hierarchy without duplicates',async()=>{
  const snapshot=await vault.openExport([folder.id,child.id,loose.id]);
  assert.deepEqual(snapshot.entries.map(x=>x.path),['Folder/','Folder/child.txt','loose.txt']);
  await snapshot.release();
});
```

Add cases for empty folders, missing IDs, duplicate IDs, ancestor cycles, and colliding root paths.

- [ ] **Step 2: Run traversal tests red**

Run `node --test --test-name-pattern='openExport' test/vault.test.js`; expect `openExport is not a function`.

- [ ] **Step 3: Implement snapshot planning and leases**

Build a child index, remove roots already covered by selected ancestors, walk folders depth-first, construct paths only from validated catalog names, and increment every object reader count before returning. `release()` clears copied file keys and decrements leases exactly once, including after aborted streams.

- [ ] **Step 4: Verify deletion and close races**

Test deletion between planning and stream opening, release after stream failure, idempotent release, and vault shutdown. Run focused vault tests; expect PASS.

### Task 2: ZIP Stream And Download Tickets

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/server/zip.js`
- Modify: `src/server/server.js`
- Create: `test/zip.test.js`
- Modify: `test/server.test.js`

**Interfaces:**
- Consumes: `openExport(ids)` from Task 1.
- Produces: `createZipStream(entries) -> Readable`.
- Produces: `POST /api/downloads` and `GET /api/downloads/:token`.

- [ ] **Step 1: Install the ZIP writer**

Run `npm install yazl`. Confirm it is a runtime dependency and the lockfile records the resolved version.

- [ ] **Step 2: Write failing ZIP tests**

```js
test('ZIP stream contains files and empty folders',async()=>{
  const bytes=await collect(createZipStream(entries));
  const archive=readZipIndependently(bytes);
  assert.deepEqual(archive.names,['empty/','nested/file.txt']);
  assert.equal(archive.text('nested/file.txt'),'hello');
});
```

Add UTF-8, zero-byte, source-error, cancellation, and synthetic ZIP64 cases.

- [ ] **Step 3: Implement the ZIP adapter**

Use `yazl.ZipFile`, `addEmptyDirectory()`, and `addReadStreamLazy()` with known size, `compress:false`, and `forceZip64Format` above 4 GiB. Convert the vault async iterable with `Readable.from()`. Forward ZIP and source errors and destroy active readers on consumer cancellation.

- [ ] **Step 4: Write failing ticket-route tests**

```js
const ticket=await api.post('/api/downloads',{ids:[folder.id]});
const response=await sessionFetch(ticket.url);
assert.equal(response.headers.get('content-type'),'application/zip');
assert.equal((await sessionFetch(ticket.url)).status,404);
```

Add unauthenticated, missing-CSRF, malformed IDs, expiry, wrong session, corruption, disconnect, and shutdown cases.

- [ ] **Step 5: Implement ticket routes**

POST validates 1-10,000 unique UUIDs and stores `{ids,sessionId,expiresAt}` under a 32-byte random token. GET authenticates the same session, atomically consumes the token, opens the export snapshot, sets attachment/no-store headers, pipelines the ZIP, and releases in `finally`. Clear tickets when the server closes.

- [ ] **Step 6: Run server and ZIP tests**

Run `node --test test/zip.test.js test/server.test.js test/vault.test.js`; expect PASS.

### Task 3: Selection UI And Release Verification

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/styles.css`
- Modify: `test/web.test.js`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: ticket routes from Task 2.
- Produces: Download action for current visible selection.

- [ ] **Step 1: Write failing UI tests**

```js
assert.equal(download.disabled,true);
select(folder);select(file);
download.click();
assert.deepEqual(ticketRequest.body.ids,[folder.id,file.id]);
assert.equal(navigatedTo,'/api/downloads/token');
```

Assert a failed ticket request shows a notice and does not navigate.

- [ ] **Step 2: Implement native streaming navigation**

Add Download beside Move and Delete. Create the ticket with the existing JSON request helper, then navigate a hidden same-origin anchor to its URL so the browser handles the attachment without a Blob. Disable the button during ticket creation and retain selection after success.

- [ ] **Step 3: Update docs and package version**

Document ZIP hierarchy, temporary plaintext avoidance, and browser download location. After both implementation plans are complete, bump package and lockfile from `0.1.1` to `0.2.0`.

- [ ] **Step 4: Run release checks**

Run `npm test`, `git diff --check`, `npm pack --dry-run`, and `node bin/secretcli.js --help`; expect all tests green, clean diff checks, package `@waiyanmt/vault@0.2.0`, and Vault-branded help.
