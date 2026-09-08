# SecretCLI design

## Purpose and scope

A local, encrypted file storage app with a Drive-style browser interface, unlocked through a polished CLI. V1 runs only on the user's computer. One default vault is the initial assumption. Remote access, cloud sync, sharing, multiple vaults, and password recovery are outside v1.

## User experience

On first launch, the CLI asks the user to create and confirm a password and creates the encrypted vault. Explain at setup that losing the password means losing access to the vault. Subsequent launches use a hidden password prompt. An incorrect password leaves the vault locked and does not start the website.

After unlocking, start the local server and open the browser. If opening the browser fails, show the local address and an explicit action to retry opening it. Keep the CLI running in the foreground. Ctrl+C locks and quits.

The terminal uses a small logo, restrained colors, subtle progress indicators, and a compact running panel showing the vault name, local address, session duration, and quit instructions. Support terminals without color and avoid displaying passwords or session credentials in logs.

## Browser application

Provide a folder sidebar, breadcrumbs, file list or grid, drag-and-drop uploads, upload progress, and actions to create folders, rename, move, download, and delete files. Search by filename while unlocked. Confirm deletion; v1 has no trash or recovery feature.

Accept arbitrary file types for storage. Preview browser-supported images, audio, video, and PDFs; unsupported formats remain downloadable. Do not execute uploaded HTML, scripts, or other active content under the app's origin. Media playback must support seeking without decrypting the entire file into memory.

## Architecture and lifecycle

The foreground CLI and HTTP server run in one process, making the server's lifetime follow the CLI. Bind only to the loopback interface using an available port. Separate terminal interaction, vault operations, the authenticated HTTP interface, and browser presentation behind focused interfaces.

Successful password verification unlocks the vault key material in memory before the server starts. Each launch creates a fresh browser session. Exchange a short-lived, one-use launch credential for an HttpOnly, same-site session cookie; keep the credential out of ordinary terminal output and clear it from browser history after exchange. Protect file and metadata endpoints, validate Host and Origin, and require protection against cross-site state-changing requests. A loopback address alone is not authentication.

On normal exit, stop accepting requests, invalidate the session, close connections, release key references, and terminate the server. Abrupt process termination also removes the listening server. Do not claim guaranteed memory erasure in a managed runtime. Closing a terminal is expected to terminate the foreground process, subject to the host terminal's process behavior; verify this on the target platform.

The browser monitors the connection and clears file views, previews, and object URLs when disconnect is detected. This is best effort: a suspended tab may retain displayed content until it resumes. A server restart never restores an old session.

## Encrypted storage

Encrypt each file individually, using opaque storage identifiers. Encrypt original filenames, folder structure, and searchable metadata. The vault will still expose its existence and approximate storage sizes.

Use an established cryptographic implementation with a password-based key derivation function, a unique salt, and authenticated encryption. Derive a wrapping key from the password and use it to protect randomly generated vault key material. Store only encrypted key material, salts, format versions, and required derivation parameters on disk. Select and verify the concrete cryptographic format and library during implementation planning, before implementation.

Large files use authenticated chunks with unique nonces and authenticated file identity, ordering, and length, so corruption, truncation, or reordered chunks fail validation. Memory use must be bounded for uploads, previews, and downloads. Commit metadata and files with crash-safe writes so interrupted operations do not make existing files inaccessible; incomplete uploads are never presented as complete files.

Do not deliberately write decrypted previews, thumbnails, or upload temporary files to disk. Use no-store responses for sensitive browser content and avoid persistent browser storage or offline caching. These measures do not guarantee that the operating system or browser never persists memory. Explicit downloads create plaintext files outside the vault, and uploading does not delete the original source file.

## Errors and validation

Wrong passwords, corrupted files, interrupted uploads, a full disk, and browser launch failures produce concise actionable messages without leaking secrets. Prevent simultaneous processes from modifying the same vault. On lock during an upload, abandon the incomplete upload safely.

Validate password creation and unlock, authenticated file round trips, metadata confidentiality, wrong-password rejection, tamper and truncation detection, large-file streaming and seeking, interrupted-write recovery, and concurrent-open rejection. Verify unauthorized browser requests fail, old sessions expire, Ctrl+C and forced termination stop serving, and browser views clear after disconnect. Visually review the CLI and browser flow on the target computer.

## Next step

Review this design, then select the implementation stack and concrete encryption format using current documentation and produce an implementation plan.
