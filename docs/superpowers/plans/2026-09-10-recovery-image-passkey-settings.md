# Recovery Image And Passkey Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generated PNG recovery key and authenticated passkey enable/disable controls using vault header version 3.

**Architecture:** Extend the public header with independently wrapped recovery-image and optional passkey envelopes while preserving data version 1 and v1/v2 readers. Keep PNG parsing and generation isolated, converge every unlock method through catalog authentication, and expose key mutations only through authenticated ready-mode server routes.

**Tech Stack:** Node.js 24, Web Crypto primitives from `node:crypto`, browser-native WebAuthn, PNG chunks, node:test, Happy DOM

## Global Constraints

- Recovery images are bearer secrets and remain outside the vault and `.scvault` exports.
- Keep all existing `secretcli-*` cryptographic contexts unchanged for old envelopes.
- Header mutations are atomic; catalog and object ciphertext are never rewritten.
- Versions 1 and 2 remain readable; older binaries fail closed on version 3.
- Browser key-management routes require authenticated sessions, exact-origin checks, and CSRF.

---

### Task 1: Recovery PNG Codec And Key Derivation

**Files:**
- Create: `src/vault/recovery-image.js`
- Modify: `src/vault/crypto.js`
- Create: `test/recovery-image.test.js`
- Modify: `test/crypto.test.js`

**Interfaces:**
- Produces: `createRecoveryImage(vaultId) -> { image: Buffer, secret: Buffer }`.
- Produces: `readRecoveryImage(image, expectedVaultId) -> Buffer` containing a copied 32-byte secret.
- Produces: `deriveRecoveryImageKey(secret, salt, vaultId) -> Promise<Buffer>`.

- [ ] **Step 1: Write failing codec tests**

```js
test('generated recovery PNG carries one vault-bound secret',()=>{
  const {image,secret}=createRecoveryImage(vaultId);
  assert.equal(image.subarray(1,4).toString(),'PNG');
  assert.deepEqual(readRecoveryImage(image,vaultId),secret);
  assert.throws(()=>readRecoveryImage(image,randomUUID()),/different vault/i);
});

test('recovery PNG rejects corruption and duplicate key chunks',()=>{
  const {image}=createRecoveryImage(vaultId);
  const changed=Buffer.from(image);changed[changed.length-20]^=1;
  assert.throws(()=>readRecoveryImage(changed,vaultId),/invalid recovery image/i);
  assert.throws(()=>readRecoveryImage(duplicateKeyChunk(image),vaultId),/invalid recovery image/i);
});
```

- [ ] **Step 2: Run the codec tests red**

Run `node --test test/recovery-image.test.js`; expect module-not-found or missing-export failures.

- [ ] **Step 3: Implement the strict PNG codec**

Generate a fixed-size PNG with signature, IHDR, IDAT, one private `vaUl` chunk, and IEND. Encode `VAULTKEY`, format byte `1`, 16 UUID bytes, and 32 random bytes in `vaUl`. Validate chunk lengths and CRC-32, reject files above 2 MiB, require exactly one key chunk, and reject trailing malformed structure.

- [ ] **Step 4: Write and pass image-key derivation tests**

```js
test('image key derivation is vault and salt specific',async()=>{
  const secret=Buffer.alloc(32,1),salt=Buffer.alloc(32,2);
  const key=await deriveRecoveryImageKey(secret,salt,vaultId);
  assert.equal(key.length,32);
  assert.notDeepEqual(key,await deriveRecoveryImageKey(secret,salt,randomUUID()));
});
```

Use HKDF-SHA-256 with info `['secretcli-image-key-wrap',3,vaultId]`. Run `node --test test/recovery-image.test.js test/crypto.test.js`; expect PASS.

### Task 2: Header V3 And Vault Operations

**Files:**
- Modify: `src/vault/format.js`
- Modify: `src/vault/catalog.js`
- Modify: `src/vault/vault.js`
- Modify: `src/vault/archive.js`
- Modify: `test/vault.test.js`
- Modify: `test/archive.test.js`

**Interfaces:**
- Consumes: Recovery PNG codec and `deriveRecoveryImageKey()` from Task 1.
- Produces: prepared method `unlockWithRecoveryImage(image)`.
- Produces: unlocked methods `createRecoveryImage()`, `disablePasskey()`, `setPasskey(metadata, prfOutput)`, and `passkeyStatus()`.

- [ ] **Step 1: Write failing v3 lifecycle tests**

```js
test('recovery image unlocks v3 and replacement revokes the old image',async()=>{
  const first=await vault.createRecoveryImage();
  await vault.close();
  assert.ok(await (await prepareVault(path)).unlockWithRecoveryImage(first));
  const second=await reopened.createRecoveryImage();
  await assert.rejects((await prepareVault(path)).unlockWithRecoveryImage(first),/recovery image/i);
  assert.ok(await (await prepareVault(path)).unlockWithRecoveryImage(second));
});

test('disabled passkey v3 remains password accessible',async()=>{
  await vault.disablePasskey();
  const prepared=await prepareVault(path);
  assert.equal(prepared.version,3);assert.equal(prepared.passkey,null);
  assert.ok(await prepared.unlockWithPassword(password));
});
```

- [ ] **Step 2: Run the v3 tests red**

Run the named tests with `node --test --test-name-pattern='recovery image|disabled passkey' test/vault.test.js`; expect missing-method failures.

- [ ] **Step 3: Implement strict v3 parsing and contexts**

Set `HEADER_VERSION=3` while retaining explicit v1/v2 constants. Parse v3 recovery, nullable passkey, `passkey.wrapVersion` in `{2,3}`, and nullable `recoveryImage`. Preserve v2 recovery AAD. Use the passkey wrap version for existing and new passkey contexts. Authenticate image envelopes with `['secretcli-image-key-envelope',3,1,vaultId,salt]`.

- [ ] **Step 4: Implement queued vault mutations**

`createRecoveryImage()` generates the PNG and secret, wraps the in-memory vault key, verifies the envelope, atomically writes the header, clears temporary keys, then returns the PNG. `disablePasskey()` writes `passkey:null`. `setPasskey()` validates a 32-byte PRF output, creates and verifies a wrap-version-3 envelope, then writes it atomically. `passkeyStatus()` returns only `{enabled:Boolean(header.passkey)}`.

- [ ] **Step 5: Add archive compatibility tests and implementation**

```js
test('archive round-trips enabled and disabled v3 headers',async()=>{
  await vault.disablePasskey();await vault.close();
  await exportVault({directory:path,output:archive});
  await importVault({archive,directory:restored});
  assert.equal(JSON.parse(await readFile(join(restored,'vault.json'))).version,3);
});
```

Accept header version 3 in archive identity checks and continue rejecting versions above 3. Run `node --test test/vault.test.js test/archive.test.js`; expect PASS.

### Task 3: CLI Recovery And Ready-Mode Security API

**Files:**
- Modify: `src/cli/main.js`
- Modify: `src/server/server.js`
- Create: `web/webauthn.js`
- Modify: `web/unlock.js`
- Modify: `test/cli.test.js`
- Modify: `test/unlock.test.js`

**Interfaces:**
- Consumes: prepared and unlocked vault methods from Task 2.
- Produces: CLI password/image recovery choice.
- Produces: `GET /api/passkey`, `DELETE /api/passkey`, three authenticated registration routes, and `POST /api/recovery-image`.

- [ ] **Step 1: Write failing CLI recovery tests**

```js
test('disabled v3 prompts for password and image recovery remains selectable',async()=>{
  const prepared={version:3,passkey:null,unlockWithPassword,unlockWithRecoveryImage};
  await runHarness({prepared,input:['i','/tmp/key.png']});
  assert.equal(imagePath,'/tmp/key.png');
});
```

Verify enabled v2/v3 still starts the browser passkey flow and disabled v3 opens ready mode after password or image unlock.

- [ ] **Step 2: Write failing authenticated-route tests**

```js
await assertStatus(fetch('/api/passkey'),401);
await assertStatus(sessionFetch('/api/passkey'),200,{enabled:true});
await assertStatus(sessionFetch('/api/passkey',{method:'DELETE',withoutCsrf:true}),403);
```

Test recovery-image response type `image/png`, attachment disposition, and no-store policy.

- [ ] **Step 3: Implement CLI recovery selection**

Use hidden `readPassword()` for password recovery and visible `readText()` for an image path. Read at most 2 MiB, call `unlockWithRecoveryImage()`, clear image buffers after parsing, and keep the prepared vault retryable after a rejected image.

- [ ] **Step 4: Extract shared browser WebAuthn helpers**

Move option decoding, credential serialization, PRF extraction, and the three-step registration sequence from `web/unlock.js` into `web/webauthn.js`. Serve the module in locked, enrollment, and ready modes. Keep restricted error messages unchanged.

- [ ] **Step 5: Implement ready-mode routes**

Create a passkey service in ready mode. Place all settings routes after session and CSRF enforcement. Registration confirmation calls `vault.setPasskey()`, DELETE calls `vault.disablePasskey()`, status returns only the boolean, and image generation returns the PNG after `vault.createRecoveryImage()` commits.

- [ ] **Step 6: Run focused integration tests**

Run `node --test test/cli.test.js test/unlock.test.js test/web.test.js`; expect PASS.

### Task 4: Browser Security Controls And Documentation

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/styles.css`
- Modify: `test/web.test.js`
- Modify: `README.md`
- Modify: `docs/vault-format.md`

**Interfaces:**
- Consumes: ready-mode routes from Task 3.
- Produces: accessible passkey switch and recovery-image download action.

- [ ] **Step 1: Write failing browser behavior tests**

```js
assert.equal(passkeySwitch.checked,true);
passkeySwitch.click();confirmButton.click();
assert.deepEqual(requests.at(-1),{path:'/api/passkey',method:'DELETE'});
generateRecovery.click();
assert.equal(downloads.at(-1).type,'image/png');
```

Also assert failed disable/enable requests restore the switch and show an actionable notice.

- [ ] **Step 2: Implement the compact Security controls**

Add a sidebar Security section with a labeled native checkbox switch, status text, and Generate/Replace recovery image button. Confirm passkey disable, reuse shared WebAuthn enrollment for enable, download the small PNG through a temporary object URL, revoke it immediately after the click, and clear state on lock.

- [ ] **Step 3: Document security behavior**

Explain bearer-image storage, exact-file preservation, revocation, password fallback, disabled startup, v3 fields and AAD, archive exclusion, and inability to reconstruct deleted data.

- [ ] **Step 4: Run complete verification**

Run `npm test` and `git diff --check`; expect all tests passing and no whitespace errors.
