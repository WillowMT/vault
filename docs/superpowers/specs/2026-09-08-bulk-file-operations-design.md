# Bulk File Operations Design

## Goal

Allow users to select visible files and folders, then move or permanently delete the complete selection safely.

## Selection Interface

- Every file and folder row or card has a selection checkbox.
- The file toolbar has a select-all checkbox that selects or clears every entry currently visible after the active folder, category, search, and sort rules are applied.
- A selection bar appears only when at least one entry is selected. It displays the selected-item count and provides Move, Delete, and Clear selection actions.
- Selection is cleared when the visible data set changes, including after loading, folder navigation, category changes, searches, sort changes, view changes, bulk completion, and vault lock.

## Bulk Move

- Move uses the existing folder picker and applies one destination to all selected files and folders.
- The vault validates every selected entry before changing the encrypted catalog. Invalid identifiers, duplicate entry identifiers, invalid target folders, name collisions, and a folder move into itself or one of its descendants reject the complete operation with no catalog changes.
- Selecting both a parent folder and one of its descendants is permitted for move; each selected entry receives the selected destination.

## Bulk Delete

- Delete requires one irreversible confirmation that states the number of selected entries.
- If any selected entry is a folder, the confirmation warns that contained entries will also be permanently deleted.
- The vault validates every selected entry before changing the encrypted catalog. It collapses nested selected folders into one removal set, removes each encrypted object once, and rejects the complete request on invalid identifiers with no catalog changes.
- There is no undo or trash.

## Server Contract

- `POST /api/entries/bulk-move` accepts `{ids: string[], parentId: string|null}` and returns `{moved: number}`.
- `POST /api/entries/bulk-delete` accepts `{ids: string[]}` and returns `{deleted: number}`.
- Both routes require the existing authenticated session and CSRF protection.
- Vault methods perform catalog changes in one existing mutation transaction, preserving encrypted metadata and catalog persistence behavior.

## Validation

- Vault tests cover successful move/delete, nested selected folders, invalid selections, collisions, and self-descendant move rejection without partial catalog changes.
- HTTP tests cover authentication, CSRF, accepted request shapes, and API results.
- Browser tests cover select-all limited to visible items, bulk move, warning-confirmed deletion, and selection reset after data reloads.
