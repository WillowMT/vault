# Passkey Unlock Design

## Goal

Make a synced browser passkey, verified with Touch ID on macOS, the primary way to unlock SecretCLI while retaining a terminal-only recovery password.

## Architecture

- Vault format v2 stores recovery-password and passkey envelopes around the same random 32-byte vault key.
- The recovery envelope keeps the current scrypt-based wrapping scheme.
- The passkey envelope uses HKDF-SHA-256 over WebAuthn PRF output with vault-specific context.
- Passkey metadata in `vault.json` contains the credential ID, public key, counter, transports, PRF salt, and wrapped vault key. Biometric data and plaintext keys are never stored.
- The HTTP server binds to `127.0.0.1` but advertises `http://localhost:<port>` so WebAuthn uses the stable RP ID `localhost`.
- Before unlock, the server exposes only login assets and short-lived WebAuthn challenge endpoints. Vault APIs remain unavailable.
- Registration and authentication require a platform authenticator, discoverable credential, and user verification.

## Setup And Migration

- New setup creates a recovery password in the terminal, creates the encrypted vault, and requires successful passkey enrollment before setup completes.
- A v1 password-only vault is unlocked once in the terminal, then migrated atomically after successful passkey enrollment.
- Migration changes only the public header and vault-key envelopes. Existing catalog and object ciphertext retain data format v1.
- Failed or cancelled enrollment leaves the original v1 vault usable.

## Unlock And Recovery

- Normal v2 launch acquires the vault lock, starts a restricted server, and opens a browser login page.
- A user action invokes WebAuthn. The server verifies the challenge, origin, RP ID, credential, signature, user verification, and counter before using PRF output to unwrap the vault key.
- Successful vault-key unwrapping must also authenticate and decrypt the catalog before any browser session is issued.
- Unsupported WebAuthn/PRF, missing credentials, or authentication failure offers terminal recovery.
- Recovery passwords are entered only in the terminal. Recovery unlock can replace a lost passkey.
- Initial scope stores one iCloud-synced passkey credential per vault.

## Security

- Challenges are random, short-lived, single-use, and invalidated after every attempt.
- PRF output, recovery passwords, and vault keys are never logged or persisted and mutable buffers are cleared where practical.
- Locked mode reveals no filenames, catalog details, previews, downloads, or mutation APIs.
- Header and migration writes are atomic. Incorrect assertions, PRF output, or modified envelopes fail closed.
- The threat model protects vault contents at rest while SecretCLI is stopped. Same-user malware while unlocked remains outside scope.

## Validation

- Automated tests cover key envelopes, wrong keys, v1 migration rollback, registration/assertion failures, challenge replay and expiry, locked-route isolation, recovery, session upgrade, and shutdown.
- Browser tests mock credential APIs for state handling.
- Migration remains gated until real Touch ID registration and unlock succeed in current Safari and Chromium. Browsers without usable PRF fall back to terminal recovery.
