# Vault

A local encrypted drive that opens from your terminal. Requires Node.js 24 or newer. No hosted services.

## Install

Requires Node.js 24 or newer and macOS (Touch ID passkey unlock needs a Mac with Touch ID; other platforms have not been verified).

```sh
npm install -g @waiyanmt/vault
```

## Start

Run:

```sh
vault
```

On first launch, choose and confirm a password of at least 12 characters. The default vault is `~/.secretcli/vault`. Later launches ask for that password before starting the website and opening your browser.

Keep the CLI running. **Ctrl+C locks the vault and stops the website.** Press **O** to reopen the browser or **L** to display a fresh one-use launch link. The plain local address alone does not authenticate a browser.

```sh
vault --vault /path/to/my-vault
vault --no-open
vault --help
```

The target directory must not already exist when creating a vault.

## Files

Create folders, upload any file type, search filenames, rename, move, download, and permanently delete files. Select visible files and folders and choose **Download** to save one ZIP; selected folders retain their hierarchy and empty folders. The ZIP streams directly to your browser's normal download location without a plaintext temporary file or a whole-archive memory buffer. List and grid views and media categories are available. Supported browser image, audio, and video formats preview in the app. PDFs and unsupported formats download to open in another viewer. Upload folders by creating the folder in the app and adding its files.

File contents, names, folder structure, and metadata are encrypted. Files stream in authenticated 1 MiB chunks, including when seeking in large media. Limits: 1 TiB per file, two concurrent server uploads, and a 32 MiB metadata catalog. The browser queues uploads sequentially.

## Passkeys and recovery files

New vaults enroll a passkey during setup. After locking, relaunching presents a browser prompt to unlock with Touch ID instead of typing the password. The recovery password always works from the terminal (press **R** at the passkey prompt). In the browser sidebar, **Security** shows the current passkey state. Turning a passkey off requires confirmation; the next launch uses terminal recovery. Turning it on performs a fresh WebAuthn enrollment.

**Generate / replace recovery file** downloads a file that can unlock this vault from the terminal. The exact file is a bearer secret: anyone with it and the vault can unlock the vault. Keep an unchanged copy somewhere separate and private, and do not edit or re-encode it. Generating another file commits a new key and immediately revokes the previous file. The file itself is never stored in the vault or included in a `.scvault` export, so losing every copy cannot be repaired from the vault or an export. A recovery file grants access to existing encrypted data; it cannot reconstruct files already deleted from the vault.

## Multiple vaults

Vaults are tracked in `~/.secretcli/vaults.json`. Launching `vault` without `--vault` opens your most recent vault, or shows a picker when several are registered. `vault --vault work` opens a vault by its list name; a filesystem path works too. Each `vault` process opens one vault — run a second `vault --vault other` in another terminal to work with two vaults at once (opening the same vault twice stays blocked).

Manage the list with:

```sh
vault vaults                      # list registered vaults
vault vaults --add ~/vaults/work  # register an existing vault (name optional)
vault vaults --remove work        # unregister — files on disk are not touched
```

## Export and import

```sh
vault export --to backup.scvault                     # export your vault
vault export --vault work --to work-backup.scvault   # export a named vault
vault import backup.scvault --out ~/vaults/restored  # restore to a new directory
```

Export requires the vault to be closed (quit with Ctrl+C first) and needs no password: the archive contains only encrypted data, so it is safe to store on a USB drive or in cloud storage. Import verifies every file against the manifest's SHA-256 checksums while writing, refuses an existing destination, and registers the restored vault in your vault list. Unlock a restored vault with its original recovery password, passkey, or the matching recovery PNG. The bearer PNG is not included in the export.

Exporting an old backup and later unlocking its passkey can conflict with a newer passkey counter on hardware security keys; the recovery password always unlocks a restored vault.

## Locking and recovery

There is **no way to reset a forgotten password**. A previously generated recovery file is an independent unlock method, not a password reset. Back up the entire vault directory while the CLI is stopped; restore the entire directory together. Deletion is permanent and neither backups of keys nor recovery files reconstruct deleted data. Original files you upload and files you explicitly download remain outside the encrypted vault.

Normal termination closes the server; forced termination also removes the server process. A new launch rejects the previous browser session. The browser clears its view when it detects disconnection, usually within a few seconds; suspended tabs clear after they resume. The app does not deliberately cache plaintext previews on disk, but cannot guarantee that the OS or browser never persists memory. This is protection for data at rest, not protection from malware or another process already controlling your user account while unlocked. The vault format has not undergone independent security review.

Only one process can open a vault. Locks belonging to a dead process are recovered automatically. If setup or lock creation was interrupted before ownership information was written, stop all Vault processes and back up the directory first. Only then remove the `.lock` directory and/or `.recovery` marker inside that vault and retry. Do not delete `vault.json`, `catalog.enc`, or `objects`. An incomplete first-time setup can be removed and recreated only if it has never held user files.

## Development

```sh
npm install
npm test
```

Tests use disposable vaults. Happy DOM is a development-only dependency for UI integration tests; a successful DOM test does not verify actual browser rendering or media codecs.
