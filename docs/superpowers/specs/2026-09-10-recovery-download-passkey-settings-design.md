# Recovery Image, Bulk Download, And Passkey Settings Design

## Goal

Add three independent user capabilities without changing encrypted catalog or object formats:

- Unlock a vault with a generated secret PNG when the recovery password and passkey are unavailable.
- Download selected files and folders as one streaming ZIP.
- Enable or disable passkey unlock from the authenticated browser UI.

## Vault Header Version 3

Version 3 keeps `dataVersion` at 1 and preserves the existing recovery-password envelope. It adds an optional recovery-image envelope and makes the passkey envelope optional.

An enabled v2 vault can move to v3 without its PRF output by preserving its existing passkey envelope and recording that envelope's wrapping version as 2. Newly enrolled passkeys use wrapping version 3. Disabled passkeys are represented as `null`; recovery images are absent as `null`. Older binaries reject v3 rather than misreading its state.

All header mutations use the existing atomic writer. Catalog and object ciphertext are not rewritten. Versions 1 and 2 remain readable.

## Recovery Key Image

### Artifact

Vault generates a small valid PNG containing a private ancillary chunk with:

- A fixed Vault recovery-image signature.
- Recovery-image format version 1.
- The vault UUID.
- A cryptographically random 32-byte secret.

The PNG has ordinary static artwork; the visible pixels do not encode the secret. PNG chunk CRC protects accidental corruption. The parser accepts only the generated format, enforces a small file-size limit, rejects duplicate key chunks, validates the vault UUID, and clears secret buffers after use.

The image is a bearer recovery key. Anyone with both the image and vault data can unlock the vault. Documentation and UI warn users to store it separately and privately. Editing, recompressing, uploading through an image optimizer, or sending through a messaging service may remove its private chunk and make it unusable.

### Envelope

The image secret derives a 32-byte wrapping key with HKDF-SHA-256 using a fresh salt and a domain-separated context containing header version 3 and `vaultId`. The resulting header envelope wraps the existing vault key with AES-256-GCM and authenticates its version, vault identity, salt, and image-key metadata.

The image does not contain the vault key. Regenerating the image creates a new secret and atomically replaces the header envelope, immediately revoking the old image for the current vault state.

### User Flow

The authenticated UI provides **Generate recovery image** or **Replace recovery image**. The server commits the new envelope and returns the small PNG as a download. If the browser fails to save it, the user can generate a replacement.

Terminal recovery presents password and recovery-image choices. Image recovery asks for a path, parses the PNG locally, unlocks through the same catalog-authentication convergence point as password and passkey recovery, and opens a fresh browser session. A recovery image unlocks an existing vault or restored encrypted backup; it cannot reconstruct missing or deleted vault data.

The recovery image is external and never included in `.scvault` exports.

## Passkey Settings

The unlocked sidebar gains a compact Security section with an accessible passkey switch and recovery-image action.

Turning passkeys off requires confirmation, atomically writes v3 with `passkey: null`, and explains that the next launch will prompt for the recovery password. Turning passkeys on performs a fresh three-step WebAuthn registration and PRF confirmation in the authenticated session, then writes a new v3 passkey envelope around the in-memory vault key.

Ready-mode passkey routes require the existing session, exact-origin checks, and CSRF token. Status returns only `{ enabled: boolean }`. Credential IDs, public keys, salts, and PRF output are never exposed by the status route. Failed ceremonies restore the switch's previous visual state.

A disabled v3 vault prompts for its recovery password at startup and opens directly in ready mode. It does not force passkey enrollment. Recovery-image unlock remains available from that prompt. Enabled v2 and v3 vaults retain the locked-browser passkey flow.

## Selected-Item ZIP Download

The existing selection toolbar gains a **Download** action. It sends the visible selected IDs to a CSRF-protected endpoint and receives a short-lived, random, single-use download URL. Browser navigation to that URL streams the ZIP directly to disk without constructing a full archive Blob.

The vault resolves all roots and descendants before streaming, removes duplicate descendants when an ancestor is selected, preserves empty folders and hierarchy, rejects missing or colliding roots, and leases every included encrypted object until the export finishes or aborts. Deletion cannot remove a planned object during an active download.

ZIP generation uses `yazl` with lazy read streams, store-only entries, known plaintext sizes, UTF-8 paths, and ZIP64 for large entries. Plaintext flows from authenticated object chunks through the ZIP stream to the HTTP response. No plaintext temporary files are created and complete files are never buffered in memory.

Tickets expire after 30 seconds, are tied to the current authenticated session, and are consumed once. The server limits a request to 10,000 selected IDs and clears all outstanding tickets at shutdown. ZIP responses use `application/zip`, attachment disposition, and `Cache-Control: no-store`; they do not support ranges.

## Error Handling

- Wrong-vault, malformed, altered, or revoked recovery images fail without consuming the prepared vault or preventing another recovery attempt.
- Failed header mutations leave the previous password, passkey, and recovery-image state usable.
- ZIP planning errors return JSON before response streaming begins.
- Object corruption or client disconnect aborts the ZIP and releases every lease.
- WebAuthn failures expose safe, actionable messages without leaking verification details.

## Testing

### Recovery And Header

- Parse generated PNGs and reject malformed, oversized, duplicate-chunk, wrong-vault, and modified files.
- Verify image unlock, wrong-image retry, buffer clearing, regeneration revocation, and shutdown races.
- Verify atomic v2-to-v3 upgrade while preserving v2 passkey access.
- Verify v1/v2 compatibility and v3 archive round trips.

### Passkey Settings

- Verify enabled and disabled v3 startup paths.
- Verify authenticated status, disable, registration, and confirmation routes with CSRF enforcement.
- Verify switch rollback on cancellation or request failure.
- Verify no credential metadata is returned by status.

### Bulk Download

- Verify files, nested folders, empty folders, Unicode names, duplicate selections, and ZIP64 metadata.
- Independently inspect ZIP entries and plaintext contents.
- Verify ticket authentication, expiry, single use, shutdown cleanup, stream failure, cancellation, and export-lease release.
- Verify the browser sends selected visible IDs and navigates to the returned ticket URL.

## Documentation And Release

Update `README.md` and `docs/vault-format.md` with the v3 format, image-key handling, passkey settings, ZIP behavior, and recovery limitations. Add `yazl` as a runtime dependency. Treat the feature set as a minor release and bump the package from `0.1.1` to `0.2.0` only when preparing its npm release.
