# SecretCLI

A local encrypted drive that opens from your terminal. Requires Node.js 24 or newer. No runtime dependencies or hosted services.

## Start

From this project directory:

```sh
npm start
```

On first launch, choose and confirm a password of at least 12 characters. The default vault is `~/.secretcli/vault`. Later launches ask for that password before starting the website and opening your browser.

Keep the CLI running. **Ctrl+C locks the vault and stops the website.** Press **O** to reopen the browser or **L** to display a fresh one-use launch link. The plain local address alone does not authenticate a browser.

```sh
node bin/secretcli.js --vault /path/to/my-vault
node bin/secretcli.js --no-open
node bin/secretcli.js --help
```

The target directory must not already exist when creating a vault. The application is intended for macOS; other platforms have not been verified.

## Files

Create folders, upload any file type, search filenames, rename, move, download, and permanently delete files. List and grid views and media categories are available. Supported browser image, audio, and video formats preview in the app. PDFs and unsupported formats download to open in another viewer. Upload folders by creating the folder in the app and adding its files.

File contents, names, folder structure, and metadata are encrypted. Files stream in authenticated 1 MiB chunks, including when seeking in large media. Limits: 1 TiB per file, two concurrent server uploads, and a 32 MiB metadata catalog. The browser queues uploads sequentially.

## Locking and recovery

There is **no password recovery**. Back up the entire vault directory while the CLI is stopped; restore the entire directory together. Deletion is permanent. Original files you upload and files you explicitly download remain outside the encrypted vault.

Normal termination closes the server; forced termination also removes the server process. A new launch rejects the previous browser session. The browser clears its view when it detects disconnection, usually within a few seconds; suspended tabs clear after they resume. The app does not deliberately cache plaintext previews on disk, but cannot guarantee that the OS or browser never persists memory. This is protection for data at rest, not protection from malware or another process already controlling your user account while unlocked. The vault format has not undergone independent security review.

Only one process can open a vault. Locks belonging to a dead process are recovered automatically. If setup or lock creation was interrupted before ownership information was written, stop all SecretCLI processes and back up the directory first. Only then remove the `.lock` directory and/or `.recovery` marker inside that vault and retry. Do not delete `vault.json`, `catalog.enc`, or `objects`. An incomplete first-time setup can be removed and recreated only if it has never held user files.

## Development

```sh
npm install
npm test
```

Tests use disposable vaults. Happy DOM is a development-only dependency for UI integration tests; a successful DOM test does not verify actual browser rendering or media codecs.
