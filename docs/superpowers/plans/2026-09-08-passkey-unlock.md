# Passkey Unlock Implementation Plan

**Goal:** Add Touch ID passkey unlock on macOS with a terminal-only recovery password.

**Architecture:** Split public-header and encrypted-data versions, add recovery and WebAuthn PRF key envelopes, verify WebAuthn server-side, and let the loopback server transition from locked login mode to the existing unlocked vault API.

**Tech Stack:** Node.js 24, ESM, WebAuthn, `@simplewebauthn/server`, browser-native JavaScript, Node test runner, Happy DOM.

## Tasks

1. Add v2 header parsing, HKDF passkey wrapping, key-based catalog loading, and atomic v1 migration tests.
2. Add WebAuthn registration/authentication verification with required user verification and expiring one-use challenges.
3. Refactor the server to advertise `localhost`, serve a locked login surface, deny vault APIs while locked, and issue the existing session only after unlock.
4. Add browser enrollment and login flows using native credential APIs and explicit PRF capability/result checks.
5. Update CLI setup, migration, normal launch, recovery prompt, passkey replacement, and shutdown behavior.
6. Run the complete automated suite and perform manual Touch ID acceptance in Safari and Chromium before enabling migration by default.

## Constraints

- Keep catalog/object data format v1 during header migration.
- Never send or accept recovery passwords through the browser.
- Never expose vault routes before catalog authentication succeeds.
- Failed setup or migration must leave a password-unlockable vault.
- Keep loopback binding, exact Host/Origin checks, one-use sessions, CSRF protection, and no-store responses.
