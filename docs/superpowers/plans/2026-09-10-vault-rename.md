# Vault Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the public application identity to Vault and publish it as `@waiyanmt/vault` without breaking existing encrypted data.

**Architecture:** Update package metadata, executable aliases, current documentation, browser copy, CLI copy, and WebAuthn display names. Preserve cryptographic contexts, storage paths, cookie names, archive extensions, format documentation, historical design documents, and the existing executable file path as compatibility internals.

**Tech Stack:** Node.js 24, npm, browser-native HTML/CSS/JavaScript, node:test

## Global Constraints

- Package name is `@waiyanmt/vault` at version `0.1.1` with public npm access.
- Primary command and visible product name are `vault` and `Vault`.
- Keep `secretcli` as a compatibility command.
- Preserve `~/.secretcli`, `.scvault`, and all `secretcli-*` cryptographic or persisted identifiers.
- Require explicit confirmation immediately before publishing.

---

### Task 1: Rename And Verify Public Surfaces

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `src/cli/main.js`
- Modify: `src/cli/prompt.js`
- Modify: `src/auth/passkeys.js`
- Modify: `src/server/server.js`
- Modify: `src/server/unlock.js`
- Modify: `src/vault/archive.js`
- Modify: `src/vault/registry.js`
- Modify: `web/app.js`
- Modify: `web/index.html`
- Modify: branding assertions in `test/*.test.js`

**Interfaces:**
- Consumes: Existing CLI arguments, vault files, settings, archives, and browser flows.
- Produces: `vault` as the primary command, `secretcli` as an alias, and Vault-branded output with unchanged persisted compatibility.

- [ ] **Step 1: Update branding assertions**

Change tests that expect the WebAuthn relying-party or user display name from `SecretCLI` to `Vault`.

- [ ] **Step 2: Rename public package and application surfaces**

Set the scoped package name, `publishConfig.access`, both bin aliases, current docs, CLI usage, browser labels, errors, and WebAuthn display names. Leave persisted identifiers unchanged.

- [ ] **Step 3: Run tests**

Run `npm test`; expect all tests to pass.

- [ ] **Step 4: Verify package**

Run `npm pack --dry-run`; expect package name `@waiyanmt/vault`, version `0.1.1`, and only intended files.

- [ ] **Step 5: Verify npm release prerequisites**

Run `npm whoami` and `npm view @waiyanmt/vault version`; confirm the authenticated account and whether the package already exists.

- [ ] **Step 6: Publish only after confirmation**

Run `npm publish --access public` only after the user explicitly approves the irreversible release.
