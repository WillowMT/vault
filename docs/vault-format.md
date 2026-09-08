# Vault format v1

`vault.json` holds format version, a random UUID vault identifier, 32-byte base64 salt, scrypt parameters, and the base64 wrapped vault key. The password derives a 32-byte wrapping key with scrypt N=131072, r=8, p=1 and maxmem=256 MiB. Parameter values must match the supported format exactly.

The wrapped random 32-byte vault key uses AES-256-GCM. Its AAD is UTF-8 JSON serialization of `["secretcli-envelope",version,vaultId,salt,kdf]`. General encrypted records contain a random 12-byte nonce, ciphertext, and a 16-byte authentication tag. Authentication completes before plaintext is returned.

`catalog.enc` encrypts a JSON array of entries with the vault key. AAD is `["secretcli-catalog",1,vaultId]`. The catalog includes names, parent IDs, kinds, sizes, MIME types, timestamps, opaque object IDs and per-file keys. The plaintext catalog is limited to 32 MiB. Passwords are not persisted.

`objects/<uuid>` contains immutable file ciphertext. Every object has an independent random 32-byte key stored inside the encrypted catalog. Each plaintext chunk is at most 1 MiB and is followed by its 16-byte GCM tag. Its nonce is four zero bytes followed by the unsigned big-endian 64-bit chunk index. AAD is `["secretcli-object",1,vaultId,objectId,index,plaintextLength]` serialized as UTF-8 JSON. Never reuse a file key for a new object. The authenticated catalog size determines the chunk count and expected ciphertext length. Empty files have zero ciphertext bytes. The format reveals approximate sizes and the existence of a vault; it does not prevent rollback of an entire valid older vault backup.

Uploads write encrypted `.partial` objects, sync and rename them, then commit the catalog. Catalog replacement uses a same-directory temporary file, file sync, rename, and directory sync. Deletion commits metadata before unlinking objects. Orphan and partial objects are removed after exclusive lock acquisition and successful catalog authentication on startup. First-time setup reserves a fresh destination and publishes its staged files; interruption during publication can leave an incomplete setup which fails closed.

Vault directories use mode 0700 and files 0600. Root and internal object directories reject symlinks; encrypted file reads use O_NOFOLLOW. `.lock/owner.json` records a PID and ownership token. Dead-owner lock recovery is serialized with `.recovery`; incomplete ownership information requires manual recovery. Managed-runtime key references are released and mutable key buffers cleared where practical; guaranteed memory erasure is not claimed.
