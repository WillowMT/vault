# SecretCLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Those skills are not present in this workspace's skill catalog; do not claim to have loaded them. Execution can proceed inline under the available implementation and testing skills. Delegation requires applicable authorization.

**Goal:** Build a local encrypted Drive-style app that unlocks through a polished foreground CLI and stops serving when that CLI exits.

**Architecture:** One Node.js process owns the terminal, unlocked vault, and loopback HTTP server. An encrypted metadata catalog references immutable, individually encrypted file objects. A browser interface uses a session created by that CLI launch.

**Tech Stack:** Node.js 24 or newer, ESM JavaScript with JSDoc contracts, built-in crypto/HTTP/filesystem/test modules, and browser-native HTML/CSS/JavaScript. No hosted service, frontend build server, database service, or runtime UI framework is needed. Initial platform: this macOS computer; Node.js v26.3.0 is installed.

## Global Constraints

- “V1 runs only on the user's computer.”
- “One default vault is the initial assumption.”
- “Remote access, cloud sync, sharing, multiple vaults, and password recovery are outside v1.”
- “The foreground CLI and HTTP server run in one process, making the server's lifetime follow the CLI.”
- “Encrypt original filenames, folder structure, and searchable metadata.”
- “Do not deliberately write decrypted previews, thumbnails, or upload temporary files to disk.”
- “Media playback must support seeking without decrypting the entire file into memory.”
- “A server restart never restores an old session.”
- “Do not claim guaranteed memory erasure in a managed runtime.”

## Documentation and decisions

Use the official [Node.js crypto documentation](https://nodejs.org/api/crypto.html) for `scrypt`, `createCipheriv`, `setAAD`, `getAuthTag`, and authenticated decryption. Use the [HTTP documentation](https://nodejs.org/api/http.html) for server binding, request streams, and connection shutdown. These document the primitives; the vault format below is this project's design, not an externally audited storage format.

Use scrypt with a random 32-byte salt, N=131072, r=8, p=1, 32-byte output, and maxmem=256 MiB. Use AES-256-GCM with 12-byte nonces and 16-byte tags. Check parameter bounds before deriving keys from disk data. Use asynchronous password derivation. Do not silently weaken parameters if derivation fails.

Default vault: `~/.secretcli/vault`; implementation and tests must use temporary fixture directories until the user launches the app. Directory permissions 0700, files 0600. Never place actual vault data in the repository. `--vault <path>` permits selecting a filesystem location without adding a multi-vault management interface.

## File map and shared contracts

| Files | Responsibility |
| --- | --- |
| `package.json`, `.gitignore`, `bin/secretcli.js` | Package entry, commands, generated-data exclusions |
| `src/vault/crypto.js`, `format.js` | Password wrapping, authenticated records, binary constants |
| `src/vault/catalog.js`, `atomic.js`, `lock.js` | Encrypted metadata, durable replacement, exclusive writer |
| `src/vault/objects.js`, `vault.js` | Streaming object IO and public vault operations |
| `src/server/session.js`, `security.js`, `ranges.js`, `server.js` | Browser authentication, request policy, byte ranges, HTTP routes |
| `src/cli/prompt.js`, `view.js`, `main.js` | Hidden input, terminal appearance, application lifecycle |
| `web/index.html`, `styles.css`, `app.js`, `api.js`, `preview.js` | File browser and disconnect clearing |
| `test/*.test.js`, `test/helpers.js` | Behavior and lifecycle regression tests |
| `README.md`, `docs/vault-format.md` | Usage, limitations, exact storage format |

Use these contracts consistently (JSDoc type declarations belong in `src/vault/vault.js`):

```js
// Entry = { id: string, parentId: string|null, name: string,
//   kind: 'file'|'folder', size: number, mime: string, createdAt: string,
//   objectId?: string, fileKey?: string }
// PublicEntry = Entry excluding fileKey and objectId
// Vault = {
//   list(parentId: string|null, query?: string): PublicEntry[],
//   mkdir(parentId: string|null, name: string): Promise<PublicEntry>,
//   upload(parentId: string|null, name: string, mime: string,
//          bytes: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<PublicEntry>,
//   update(id: string, patch: {name?: string, parentId?: string|null}): Promise<PublicEntry>,
//   remove(id: string): Promise<void>,
//   stat(id: string): PublicEntry,
//   read(id: string, start?: number, endInclusive?: number): AsyncIterable<Buffer>,
//   close(): Promise<void>
// }
// createVault(path: string, password: Buffer): Promise<Vault>
// unlockVault(path: string, password: Buffer): Promise<Vault>
// startServer(vault: Vault): Promise<{
//   origin: string, launchUrl: string, close(): Promise<void>,
//   renewLaunchUrl(): string
// }>
```

### Task 1: Password-protected vault envelope

**Files:** Create `package.json`, `.gitignore`, `src/vault/crypto.js`, `src/vault/format.js`, `test/crypto.test.js`.

**Interfaces:** `deriveKey(password, salt) -> Promise<Buffer>`; `seal(key, plaintext, aad) -> Buffer`; `open(key, record, aad) -> Buffer`. Records contain nonce, ciphertext, tag, with strict length checks. `open` returns bytes only after tag verification.

- [ ] Add ESM package configuration and test script: `{"type":"module","scripts":{"test":"node --test","start":"node bin/secretcli.js"},"engines":{"node":">=24"},"bin":{"secretcli":"bin/secretcli.js"}}`. Ignore `node_modules/`, `.secretcli/`, coverage, and local vault fixtures.
- [ ] Write failing tests using `node:test` and `node:assert/strict`:

```js
test('authenticated records reject changes', () => {
  const key = randomBytes(32), aad = Buffer.from('catalog:v1');
  const record = seal(key, Buffer.from('private name'), aad);
  assert.equal(open(key, record, aad).toString(), 'private name');
  record[12] ^= 1;
  assert.throws(() => open(key, record, aad));
});
test('wrong context fails', () => {
  const key = randomBytes(32);
  const record = seal(key, Buffer.from('x'), Buffer.from('one'));
  assert.throws(() => open(key, record, Buffer.from('two')));
});
```

- [ ] Run `node --test test/crypto.test.js`; confirm missing exports fail, then implement encryption with explicit AAD and tag verification. Buffer the decrypted record until `decipher.final()` succeeds.
- [ ] Add password derivation tests: same salt/password yields the same key; a different password fails to unwrap a sealed random vault key. Test malformed nonce/tag lengths and oversized format input.
- [ ] Run `node --test test/crypto.test.js` and record success. No implementation claims of independent cryptographic review.

### Task 2: Durable encrypted catalog and exclusive access

**Files:** Create `src/vault/catalog.js`, `atomic.js`, `lock.js`, `test/catalog.test.js`, `test/helpers.js`.

**Interfaces:** `acquireLock(path) -> Promise<releaseFunction>`; `writeAtomic(path, bytes) -> Promise<void>`; `createCatalog(path,password)` and `loadCatalog(path,password)` return `{ vaultId, key, entries, save(entries), close() }`. Catalog entries use the shared Entry contract.

- [ ] Write filesystem tests in temporary directories: wrong password rejects; filenames are absent from disk bytes; a second writer fails; a failed replacement preserves the previous valid catalog.

```js
test('catalog names stay encrypted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secretcli-'));
  const catalog = await createCatalog(dir, Buffer.from('test passphrase'));
  await catalog.save([{id:'folder-a', parentId:null, name:'private holiday',
    kind:'folder', size:0, mime:'', createdAt:new Date().toISOString()}]);
  assert.equal((await readFile(join(dir,'catalog.enc'))).includes('private holiday'), false);
  await catalog.close();
});
```

- [ ] Run `node --test test/catalog.test.js` and confirm failure before implementing.
- [ ] Write versioned `vault.json` containing fixed allowed KDF parameters, salt, random vault ID, and wrapped catalog key. Bind the envelope to the vault ID/version/KDF fields using deterministic AAD serialization. Encrypt the complete catalog, including per-file keys. Cap decrypted catalog at 32 MiB and reject larger mutations with a readable capacity error.
- [ ] Serialize mutations through a promise queue. Write a same-directory exclusive temporary file, sync it, rename it over the catalog, then sync the directory. Setup writes a staging directory and publishes only when the envelope and empty catalog are durable; reject existing nonempty targets.
- [ ] Use an atomic lock directory. Record PID and a random ownership token; refuse lock takeover while the PID is live or cannot be checked. Reclaim a dead-owner lock using an exclusive recovery marker; never automatically reclaim a lock with incomplete ownership data. Release only the matching token. Document manual recovery for an incomplete lock. Reject symlinked vault internals.
- [ ] Add a subprocess contention test and injected failure tests before/after rename. Run `node --test test/catalog.test.js`.

### Task 3: Streaming encrypted objects and file operations

**Files:** Create `src/vault/objects.js`, `vault.js`, `test/objects.test.js`, `test/vault.test.js`.

**Interfaces:** Implement the shared Vault contract. Internal `writeObject(directory, objectId, fileKey, bytes, signal)` returns `{size}`; `readObject(directory, objectId, fileKey, size, start, endInclusive)` yields authenticated plaintext chunks.

- [ ] Write a range round-trip test spanning a chunk boundary and tamper tests for chunk content, reordered chunks, truncation, and an appended record. Use a deterministic 2 MiB+17-byte fixture with a fresh random key:

```js
const entry = await vault.upload(null, 'movie.bin', 'application/octet-stream', [input]);
const parts = [];
for await (const part of vault.read(entry.id, 1048570, 1048590)) parts.push(part);
assert.deepEqual(Buffer.concat(parts), input.subarray(1048570, 1048591));
```

- [ ] Run `node --test test/objects.test.js test/vault.test.js` to establish failures.
- [ ] Use 1 MiB plaintext chunks and a fresh random 32-byte key for each immutable object. Nonce = four zero bytes followed by an unsigned 64-bit chunk index. AAD is the deterministic tuple `["secretcli-object",1,vaultId,objectId,index,plaintextLength]`. Reuse no object key for a replacement. Catalog-authenticated size determines the expected chunk count and exact ciphertext length; check file size before serving ranges. Empty files have no chunks and size zero. Tags occupy 16 bytes per chunk; derive offsets from fixed chunk geometry.
- [ ] Upload to an opaque `.partial` name, encrypt with backpressure, sync and rename the completed object, then commit its catalog entry. Enforce an initial 1 TiB per-file limit and at most two concurrent uploads. Never buffer a whole file. Cleanup failed partials. Startup removes orphan partials and completed objects absent from the catalog after exclusive lock acquisition.
- [ ] Implement parent validation, cycle rejection for moves, sibling name collision errors, a 255 UTF-8-byte filename limit, and rejection of empty names, path separators, control characters, `.` and `..`. Names are catalog data, never disk paths. Serialize mutation commits but perform upload streaming outside the catalog queue; recheck parent existence at commit.
- [ ] Delete metadata durably before unlinking unreachable objects; recursively delete folders only after browser confirmation. Track active object readers so deletion defers unlinking until reads finish. Closing aborts uploads, drains mutation work, and releases handles and key references.
- [ ] Add tests for failed streams, disk write failure, missing parents, moves into descendants, rename collisions, restart persistence, and download equality. Run both test files.

### Task 4: Authenticated loopback HTTP and media ranges

**Files:** Create `src/server/session.js`, `security.js`, `ranges.js`, `server.js`, `test/server.test.js`.

**Interfaces:** Implement `startServer(vault)` from shared contracts; `parseRange(header,size) -> {start,end}|null` throws a range error for unsatisfiable or multiple ranges.

- [ ] Write integration tests against `127.0.0.1` and an ephemeral port: API without cookie returns 401; forged Host/Origin returns 403; launch token is one-use; previous session cannot authenticate a new server.

```js
const app = await startServer(vault);
try {
  const response = await fetch(`${app.origin}/api/entries`);
  assert.equal(response.status, 401);
} finally { await app.close(); }
```

- [ ] Run `node --test test/server.test.js` to confirm failure before implementing.
- [ ] Generate 32-byte random launch and session tokens. Put the launch token in the URL fragment, valid for 60 seconds; exchange via same-origin `POST /api/session`. Set a host-only HttpOnly SameSite=Strict cookie with Path=/; local HTTP uses no Secure flag. Return a separate CSRF token stored only in browser memory. Reload can obtain CSRF via authenticated `GET /api/session`. Renewing the launch URL invalidates any unused launch token.
- [ ] Bind exactly `127.0.0.1`. Validate Host against the actual port. Require exact Origin and `X-CSRF-Token` for mutations after launch; reject cross-site fetch metadata. Do not enable CORS. Permit unauthenticated static shell assets only, with no vault information. Set no-store, nosniff, Referrer-Policy:no-referrer, and CSP restricting scripts/connect/media to self, images to self/blob, styles to self, objects and frames to none, and frame-ancestors to none.
- [ ] Implement routes: `GET /api/entries?parentId=&q=`, `POST /api/folders {parentId,name}`, raw-body `POST /api/files?parentId=&name=` with Content-Type, `PATCH /api/entries/:id {name?,parentId?}`, `DELETE /api/entries/:id`, `GET /api/files/:id/content`, `GET /api/files/:id/download`, and `GET /api/heartbeat`. JSON bodies cap at 16 KiB; return 400 for invalid inputs, 404 missing IDs, 409 collisions, 413 size limits, 507 disk-full, and generic 500 otherwise. Never expose disk paths or stack traces.
- [ ] Serve downloads as attachments with escaped ASCII fallback plus encoded filename*. Allow inline content only for a fixed safe image/audio/video type mapping; SVG and HTML download as attachments. Serve PDFs as attachments for opening in the browser's PDF viewer, outside the app's DOM. Range responses implement 206/Content-Range, suffix/open ranges, and 416 with bytes */size; unsupported multiple ranges return 416. Authenticate every range request.
- [ ] Set upload inactivity timeout to 60 seconds, permit actively progressing large transfers, abort writes when clients disconnect. Shutdown rejects new work and destroys open connections using tracked sockets after stopping the listener.
- [ ] Add tests for CSRF, launch expiry, range boundaries, active-content handling, invalid IDs, streaming cancellation, and socket shutdown. Run `node --test test/server.test.js`.

### Task 5: Polished CLI and process lifecycle

**Files:** Create `bin/secretcli.js`, `src/cli/prompt.js`, `view.js`, `main.js`, `test/cli.test.js`.

**Interfaces:** `readPassword({input,output,label}) -> Promise<Buffer>`; `run({argv,stdin,stdout,stderr}) -> Promise<void>`; `renderStatus({origin,startedAt,color,width}) -> string`.

- [ ] Write subprocess tests for help, invalid flags, no-TTY password rejection, and stopping an authenticated test process with SIGINT/SIGTERM/SIGHUP/SIGKILL. Inject a password reader into the CLI module's test harness; never add a production environment variable or argv password bypass.
- [ ] Run `node --test test/cli.test.js` to confirm failure.
- [ ] Add shebang entry point, `--help`, and `--vault <path>`. On setup explain password-loss consequences, require at least 12 characters, and ask twice. On unlock allow retry with a short capped delay; wrong password never starts HTTP. Restore terminal settings on input cancellation, errors, and normal exit.
- [ ] Build hidden input with raw TTY key handling, including backspace and multibyte characters. Do not echo pasted input. Handle Ctrl+C and EOF. Use muted text, a mint diamond mark, a subtle unlock spinner, elapsed time, local address, and `O open browser · Ctrl+C lock & quit`. Respect NO_COLOR, reduced terminal width, and non-animated fallback output. Write minimal screen regions instead of clearing the terminal history.
- [ ] Start the server only after unlock. Use macOS `open` via `spawn` with an argument array and no shell. The URL fragment credential is passed to the opener but never logged. If opening fails, show an action to retry with O and, only on explicit key action, display a fresh one-use launch link for manual copying.
- [ ] Install one idempotent shutdown function for SIGINT/SIGTERM/SIGHUP, stdin termination, and fatal errors. Stop server, close vault, clear timers, restore terminal, and exit. Forced termination cannot run cleanup; next launch handles stale state. Verify actual terminal-close behavior manually during acceptance.
- [ ] Run CLI tests and inspect status at 40/80 columns, with and without color. Test a real hidden password prompt using a disposable vault.

### Task 6: Drive-style browser interface

**Files:** Create `web/index.html`, `styles.css`, `app.js`, `api.js`, `preview.js`.

**Interfaces:** Browser `request(path,{method,body,headers})` attaches in-memory CSRF to mutations; `lockView()` aborts transfers and clears sensitive DOM and URLs; `showPreview(entry)` selects safe preview behavior.

- [ ] Implement an accessible responsive shell: charcoal sidebar, warm off-white content area, mint accent, system fonts, crisp file rows, breadcrumbs, search, storage total, New folder and Upload actions. Avoid fake files or mocked successful actions. Include empty, loading, error, upload, and locked states. Mobile layout remains usable though v1 targets this computer.
- [ ] Bootstrap the launch session before listing files; remove the fragment immediately with `history.replaceState`. Load current-session CSRF on authenticated reload. API 401 immediately calls `lockView()`.

```js
function lockView() {
  for (const controller of activeRequests) controller.abort();
  for (const url of previewUrls) URL.revokeObjectURL(url);
  activeRequests.clear(); previewUrls.clear();
  entries = []; csrfToken = null;
  document.querySelector('main').replaceChildren(lockedMessage());
}
```

- [ ] Wire folder navigation, debounced filename search, inline rename, move folder picker, folder creation dialog, download, and delete confirmation including recursive-delete wording. Render filenames with textContent, not HTML interpolation. Restore focus when dialogs close and support keyboard selection and Escape.
- [ ] Upload files sequentially by default using XMLHttpRequest progress and CSRF header; use raw File bodies, support cancellation, and show per-file failure without reporting success. Drag/drop supports files; folders can be created explicitly in v1.
- [ ] Display allowlisted images, audio and video from authenticated content URLs. PDFs use an explicit Open PDF action against the attachment endpoint. Other files show metadata and Download. Clear media src, pause playback, and remove previews on lock. Do not create service workers or use IndexedDB/localStorage for vault state.
- [ ] Poll heartbeat every two seconds with a two-second timeout. On failure clear the interface; also revalidate when a suspended tab becomes visible. Explain that reconnect requires reopening through the CLI if the session ended.
- [ ] Validate with disposable image/audio/video/PDF/unknown files: upload progress, folder operations, filename search, preview/playback/seek, exact downloads, failed upload, empty folder, keyboard interaction, and disconnect clearing. Browser automation is optional; direct visual review is part of acceptance.

### Task 7: End-to-end acceptance and user documentation

**Files:** Create `test/lifecycle.test.js`, `README.md`, `docs/vault-format.md`; modify package metadata for local installation.

- [ ] Add lifecycle regression: create disposable vault, upload known file, stop process, verify port refuses connections, reopen, verify file bytes, verify old cookie fails, terminate forcibly during upload, reopen and verify previously committed files survive.
- [ ] Run `npm test`. Fix failures before broadening checks. Inspect fixture vault files for sentinel plaintext names/content, verify bounded memory during a generated large upload and range read, and verify no plaintext temporary previews were created by the app.
- [ ] Document `npm start`, `node bin/secretcli.js --vault <path>`, and optional `npm link` only as a user installation command. Explain local-only behavior, terminal lifetime, vault location, backup of the entire locked vault directory, no password recovery, retained originals/downloads, supported previews, capacity limits, deletion permanence, and incomplete-lock recovery after ensuring no process is active.
- [ ] Write the exact binary format, version, KDF parameters, key hierarchy, nonce/AAD definitions, mutation ordering, size limits, and corruption behavior to `docs/vault-format.md`; match the implementation rather than copying outdated plan text.
- [ ] Complete a real macOS terminal-close check and visually inspect both CLI and browser using a temporary vault. Remove temporary test data and stop test servers. Record commands/results and any remaining limitations in the delivery message.

## Review and delivery

Coverage: Tasks 1–3 cover encrypted storage and crash recovery; Task 4 covers launch sessions, local serving and range support; Task 5 covers terminal appearance and lifecycle; Task 6 covers all file-browser actions and disconnect behavior; Task 7 covers acceptance and documentation. No implementation files exist yet. Git is not initialized, so do not report commits; if a repository exists during execution, commit completed coherent tasks following its instructions.

Execute inline as the default to avoid an unnecessary execution-mode question. The approved action for this turn is implementation planning; hand over this plan before beginning the build.
