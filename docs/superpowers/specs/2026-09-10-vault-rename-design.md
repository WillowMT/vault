# Vault Rename Design

## Goal

Rename the SecretCLI application and npm package to Vault while preserving access to existing installations and encrypted data.

## Public Identity

- Publish the npm package as `@waiyanmt/vault`.
- Expose `vault` as the primary terminal command.
- Keep `secretcli` as a compatibility command.
- Present the product as `Vault` in browser UI, terminal output, help, documentation, and package metadata.

## Compatibility Boundary

Existing vaults must continue to work without migration. Preserve the current vault format versions, encrypted record contexts, default storage and registry paths under `~/.secretcli`, `.scvault` archive extension, and persisted metadata identifiers. These implementation details are intentionally excluded from the visible rebrand.

## Packaging

Set the package name to `@waiyanmt/vault`, retain version `0.1.1`, declare public access through `publishConfig`, and include both executable aliases. Update installation and usage examples to prefer `vault`.

## Verification And Release

Update branding assertions without weakening behavioral tests. Run the complete test suite and `npm pack --dry-run`, verify the authenticated npm account and scoped package availability, then require explicit confirmation immediately before `npm publish --access public`.
