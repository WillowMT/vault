# Repository Guidelines

## Project Structure & Module Organization

Vault is a local encrypted drive. One foreground Node.js process owns the CLI, unlocked vault, and loopback HTTP server.

- `bin/secretcli.js`: executable entry point.
- `src/cli/`: password prompts, terminal rendering, and process lifecycle.
- `src/vault/`: encryption, catalog persistence, file streaming, and exclusive locks.
- `src/server/`: HTTP routes, browser sessions, request security, and byte ranges.
- `web/`: browser-native JavaScript, HTML, and CSS; no frontend build pipeline.
- `test/`: regression tests; `test/fixtures/` contains subprocess helpers.
- `docs/vault-format.md`: storage specification; `docs/superpowers/` contains design and implementation plans.

## Build, Test, and Development Commands

Use Node.js 24 or newer. macOS is the initial target.

- `npm ci`: install locked development dependencies.
- `npm start`: create or unlock the default vault and open the browser.
- `node bin/secretcli.js --vault /tmp/secretcli-dev --no-open`: use a disposable vault without opening the browser; the directory must initially be absent.
- `npm test`: run all tests with Node’s built-in test runner.
- `node --test test/vault.test.js`: run a focused test file.

There is no build, lint, or formatting command configured. Press `Ctrl+C` to stop the server and lock the vault.

## Global CLI Installation

The `vault` command is installed globally via `npm link`, which symlinks the global bin into this project so code changes are live immediately without reinstalling. If the command is missing or stale (typically after switching Node versions via mise, which keeps links per Node install), re-run `npm link` in this directory. Verify with `which vault` and `vault --help`. The legacy `secretcli` command remains an alias.

## Coding Style & Naming Conventions

Use ESM imports, explicit `.js` extensions, two-space indentation, single-quoted JavaScript strings, and semicolons. Prefer `camelCase` functions and variables, `PascalCase` classes, and descriptive lowercase filenames. Keep modules focused and preserve existing interfaces. Render user-supplied filenames with `textContent`, never HTML interpolation.

## Testing Guidelines

Use `node:test` and `node:assert/strict`; Happy DOM supports UI integration tests. Name files `*.test.js` and describe observable behavior in test names. Use temporary vaults and clean up processes and files. Cover authentication, corruption rejection, interrupted writes, streaming ranges, and shutdown when changing those behaviors. No coverage percentage is enforced. DOM tests do not verify rendering or media codecs.

## Commit & Pull Request Guidelines

This directory has no Git history, so no established commit convention exists. Use concise imperative messages. PRs should explain behavior changes, relevant issues, validation performed, and limitations. Include screenshots for UI changes when available.

## Security & Storage

Never commit passwords, launch credentials, plaintext fixtures containing real secrets, or actual vault data. Preserve loopback binding and encrypted metadata. Document format changes in `docs/vault-format.md`; maintain compatibility or provide an explicit migration strategy.
