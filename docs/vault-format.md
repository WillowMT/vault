# Vault format

SecretCLI has separate public-header and encrypted-data versions. `LEGACY_HEADER_VERSION` is 1, `HEADER_VERSION` is 2, and `DATA_VERSION` is independently fixed at 1. The compatibility export `VERSION` remains the literal value 1 for existing data-format consumers, but new format code does not use it to select a header version. Header versions 1 and 2 are supported. Catalog and object encryption remain data version 1 for both header versions.

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

## Encrypted records

General encrypted records contain a random 12-byte nonce, ciphertext, and a 16-byte AES-256-GCM authentication tag. Authentication completes before plaintext is returned.

`catalog.enc` encrypts a JSON array of entries with the vault key. AAD is `['secretcli-catalog',1,vaultId]`, including when the public header is v2. The catalog includes names, parent IDs, kinds, sizes, MIME types, timestamps, opaque object IDs and per-file keys. The plaintext catalog is limited to 32 MiB. Passwords, PRF outputs, and plaintext vault keys are not persisted.

`objects/<uuid>` contains immutable file ciphertext. Every object has an independent random 32-byte key stored inside the encrypted catalog. Each plaintext chunk is at most 1 MiB and is followed by its 16-byte GCM tag. Its nonce is four zero bytes followed by the unsigned big-endian 64-bit chunk index. AAD is `['secretcli-object',1,vaultId,objectId,index,plaintextLength]` serialized as UTF-8 JSON. Never reuse a file key for a new object. The authenticated catalog size determines the chunk count and expected ciphertext length. Empty files have zero ciphertext bytes. The format reveals approximate sizes and the existence of a vault; it does not prevent rollback of an entire valid older vault backup.

The current architecture does not rotate the vault key during passkey enrollment or replacement. Restoring an older valid v2 header can therefore restore an older passkey envelope that still unwraps the vault key and grants access to the current catalog and objects. Passkey replacement is not cryptographic revocation against header rollback; preventing that requires trusted rollback protection or vault-key rotation with data re-encryption.

## Persistence and locking

Uploads write encrypted `.partial` objects, sync and rename them, then commit the catalog. Catalog and header replacement use a same-directory temporary file, file sync, rename, and directory sync. Deletion commits metadata before unlinking objects. Orphan and partial objects are removed after exclusive lock acquisition and successful catalog authentication on startup. First-time setup reserves a fresh destination and publishes its staged files; interruption during publication can leave an incomplete setup which fails closed.

Vault directories use mode 0700 and files 0600. Root and internal object directories reject symlinks; encrypted file reads use O_NOFOLLOW. `.lock/owner.json` records a PID and ownership token. Dead-owner lock recovery is serialized with `.recovery`; incomplete ownership information requires manual recovery. A prepared vault retains this exclusive lock while callers inspect public passkey metadata and retry unlock. Closing a prepared vault waits for an in-flight unlock; if close races the attempt, no unlocked vault is returned and lock/key ownership is released. PRF inputs are copied for internal use and the internal mutable copies, wrapping keys, and vault keys are cleared where practical on success and failure. Caller-owned password and PRF buffers are not modified. Guaranteed memory erasure is not claimed.
