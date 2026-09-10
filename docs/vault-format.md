# Vault format

Vault has separate public-header and encrypted-data versions. `LEGACY_HEADER_VERSION` is 1, `PASSKEY_HEADER_VERSION` is 2, `HEADER_VERSION` is 3, and `DATA_VERSION` is independently fixed at 1. The compatibility export `VERSION` remains the literal value 1 for existing data-format consumers, but new format code does not use it to select a header version. Header versions 1, 2, and 3 are supported. Catalog and object encryption remain data version 1 for every header version.

## Public header v1

The password-only `vault.json` contains:

```json
{
  "version": 1,
  "vaultId": "UUID",
  "salt": "32-byte base64 value",
  "kdf": { "N": 131072, "r": 8, "p": 1, "maxmem": 268435456 },
  "wrapped": "base64 encrypted vault key"
}
```

The password derives a 32-byte wrapping key with scrypt. Parameter values must match the supported format exactly. The wrapped random 32-byte vault key uses AES-256-GCM with AAD equal to the UTF-8 JSON serialization of `['secretcli-envelope',version,vaultId,salt,kdf]`. Existing v1 headers remain readable, and new vaults continue to use v1 until passkey enrollment succeeds.

## Public header v2

The v2 `vault.json` contains exactly one recovery-password envelope and one passkey envelope around the same random 32-byte vault key:

```json
{
  "version": 2,
  "dataVersion": 1,
  "vaultId": "UUID",
  "recovery": {
    "salt": "32-byte base64 value",
    "kdf": { "N": 131072, "r": 8, "p": 1, "maxmem": 268435456 },
    "wrapped": "base64 encrypted vault key"
  },
  "passkey": {
    "credentialId": "unpadded base64url WebAuthn credential identifier",
    "publicKey": "unpadded base64url credential public key",
    "counter": 0,
    "transports": ["internal"],
    "prfSalt": "32-byte base64 value",
    "wrapped": "base64 encrypted vault key"
  }
}
```

The recovery wrapping key uses the same scrypt parameters as v1. Its envelope AAD is `['secretcli-recovery-envelope',2,1,vaultId,recovery.salt,recovery.kdf]`.

The passkey wrapping key is `HKDF-SHA-256(ikm, salt, info, 32)`, where `ikm` is the 32-byte WebAuthn PRF output, `salt` is the decoded 32-byte `passkey.prfSalt`, and `info` is the UTF-8 JSON serialization of `['secretcli-passkey-wrap',2,vaultId,passkey.credentialId]`. Its envelope AAD is `['secretcli-passkey-envelope',2,1,vaultId,passkey.credentialId,passkey.publicKey,passkey.counter,passkey.prfSalt]`. The authenticated counter cannot be edited without invalidating the passkey envelope. Transports remain unauthenticated public discovery hints and must be unique values from `ble`, `cable`, `hybrid`, `internal`, `nfc`, `smart-card`, and `usb`.

Passkey unlock accepts the verified assertion counter, rejects a value below the stored counter, unwraps the vault key, and authenticates the catalog. Before returning an unlocked vault, it reseals the passkey envelope with the supplied counter and atomically persists the updated header. Failure to persist prevents unlock from returning a vault.

Enrollment first validates the recovery password and passkey metadata, constructs and authenticates both envelopes in memory, and only then atomically replaces `vault.json`. Failed validation leaves the old header untouched. If a write reports failure around rename or directory fsync, the durable header may be either the complete old header or the complete new header; both contain a valid recovery envelope for the supplied password. Migration does not rewrite `catalog.enc` or any object.

## Public header v3

Header v3 preserves the v2 password-recovery envelope and makes passkey and recovery-image envelopes independently optional:

```json
{
  "version": 3,
  "dataVersion": 1,
  "vaultId": "UUID",
  "recovery": {
    "salt": "32-byte base64 value",
    "kdf": { "N": 131072, "r": 8, "p": 1, "maxmem": 268435456 },
    "wrapped": "base64 encrypted vault key"
  },
  "passkey": {
    "credentialId": "unpadded base64url WebAuthn credential identifier",
    "publicKey": "unpadded base64url credential public key",
    "counter": 0,
    "transports": ["internal"],
    "prfSalt": "32-byte base64 value",
    "wrapVersion": 3,
    "wrapped": "base64 encrypted vault key"
  },
  "recoveryImage": {
    "salt": "32-byte base64 value",
    "wrapped": "base64 encrypted vault key"
  }
}
```

`passkey` may be `null` when browser passkey unlock is disabled, and `recoveryImage` may be `null` before a recovery file is generated. A disabled v3 vault remains accessible with its recovery password or matching recovery file and starts in the terminal recovery flow. New v3 passkeys use `wrapVersion: 3`; readers also retain version 2 passkey wrapping when migrating an existing envelope.

The v3 password envelope deliberately retains the v2 AAD `['secretcli-recovery-envelope',2,1,vaultId,recovery.salt,recovery.kdf]`. Passkey key derivation uses `['secretcli-passkey-wrap',passkey.wrapVersion,vaultId,passkey.credentialId]`, and its envelope AAD is `['secretcli-passkey-envelope',passkey.wrapVersion,1,vaultId,passkey.credentialId,passkey.publicKey,passkey.counter,passkey.prfSalt]`.

The recovery-image secret derives its wrapping key with HKDF-SHA-256 using the decoded 32-byte `recoveryImage.salt` and info `['secretcli-image-key-wrap',3,vaultId]`. Its envelope AAD is `['secretcli-image-key-envelope',3,1,vaultId,recoveryImage.salt]`. The downloaded PNG contains the vault-bound 32-byte secret in one CRC-validated private chunk. It is a bearer credential and must be preserved byte-for-byte outside the vault. Replacing it atomically commits a new envelope and revokes the previous image. The PNG is not persisted in the vault or exported; only its salt and encrypted vault-key envelope are in `vault.json`.

## Encrypted records

General encrypted records contain a random 12-byte nonce, ciphertext, and a 16-byte AES-256-GCM authentication tag. Authentication completes before plaintext is returned.

`catalog.enc` encrypts a JSON array of entries with the vault key. AAD is `['secretcli-catalog',1,vaultId]`, including when the public header is v2 or v3. The catalog includes names, parent IDs, kinds, sizes, MIME types, timestamps, opaque object IDs and per-file keys. The plaintext catalog is limited to 32 MiB. Passwords, recovery-image secrets, PRF outputs, and plaintext vault keys are not persisted.

`objects/<uuid>` contains immutable file ciphertext. Every object has an independent random 32-byte key stored inside the encrypted catalog. Each plaintext chunk is at most 1 MiB and is followed by its 16-byte GCM tag. Its nonce is four zero bytes followed by the unsigned big-endian 64-bit chunk index. AAD is `['secretcli-object',1,vaultId,objectId,index,plaintextLength]` serialized as UTF-8 JSON. Never reuse a file key for a new object. The authenticated catalog size determines the chunk count and expected ciphertext length. Empty files have zero ciphertext bytes. The format reveals approximate sizes and the existence of a vault; it does not prevent rollback of an entire valid older vault backup.

The current architecture does not rotate the vault key during passkey enrollment, passkey replacement, or recovery-image replacement. Restoring an older valid v2 or v3 header can therefore restore an older envelope that still unwraps the vault key and grants access to the current catalog and objects. Replacement is not cryptographic revocation against header rollback; preventing that requires trusted rollback protection or vault-key rotation with data re-encryption.

## Export archive (`.scvault`)

An export archive is an uncompressed POSIX pax/ustar tar containing one vault directory's encrypted payload. Files larger than ustar's size field use a pax `size` record. Entry order is fixed: `manifest.json` first, then `vault.json`, `catalog.enc`, then one entry per object under `objects/<uuid>` in sorted order. Runtime files (`.lock/`, `.recovery`, `*.partial`) are never included, and object names must be UUIDs.

`manifest.json` records:

```json
{
  "format": 1,
  "vaultId": "UUID",
  "headerVersion": 3,
  "dataVersion": 1,
  "exportedAt": "ISO timestamp",
  "files": [{ "path": "vault.json", "size": 0, "sha256": "hex digest" }]
}
```

Every non-manifest entry must appear in `files` with a matching size and SHA-256; importers verify each digest while streaming and reject unexpected, missing, duplicated, or oversized entries, archives whose first entry is not `manifest.json`, and archives written by a newer format version. The archive is ciphertext-only: no password, recovery-image PNG or secret, plaintext key, or PRF output is ever included, and export holds the vault's exclusive lock for the complete snapshot. Because the payload is already encrypted and high-entropy, compression is deliberately not applied. Import exclusively reserves a fresh destination, stages `vault.json` under a temporary name, and publishes that header only after all encrypted files and checksums validate. A handled failure removes the reserved destination.

## Browser ZIP downloads

Selected browser entries are snapshotted with their validated hierarchy and streamed as one uncompressed ZIP. Selected folders include descendants and explicit directory entries preserve empty folders; overlapping selections do not duplicate entries. File plaintext flows from authenticated object readers into the ZIP response without plaintext temporary files or buffering a whole file or archive. ZIP64 is used when required. A short-lived, random, single-use ticket binds the native browser download to the authenticated session; the resulting ZIP is saved to the browser's configured download location outside the encrypted vault.

## Persistence and locking

Uploads write encrypted `.partial` objects, sync and rename them, then commit the catalog. Catalog and header replacement use a same-directory temporary file, file sync, rename, and directory sync. Deletion commits metadata before unlinking objects. Orphan and partial objects are removed after exclusive lock acquisition and successful catalog authentication on startup. First-time setup reserves a fresh destination and publishes its staged files; interruption during publication can leave an incomplete setup which fails closed.

Vault directories use mode 0700 and files 0600. Root and internal object directories reject symlinks; encrypted file reads use O_NOFOLLOW. `.lock/owner.json` records a PID and ownership token. Dead-owner lock recovery is serialized with `.recovery`; incomplete ownership information requires manual recovery. A prepared vault retains this exclusive lock while callers inspect public passkey metadata and retry unlock. Closing a prepared vault waits for an in-flight unlock; if close races the attempt, no unlocked vault is returned and lock/key ownership is released. PRF inputs are copied for internal use and the internal mutable copies, wrapping keys, and vault keys are cleared where practical on success and failure. Caller-owned password and PRF buffers are not modified. Guaranteed memory erasure is not claimed.
