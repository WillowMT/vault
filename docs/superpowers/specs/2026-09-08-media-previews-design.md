# Media Previews — Design

Date: 2026-09-08
Status: Approved

## Goal

Richer in-browser previews for files stored in the vault: inline PDF viewing,
text/markdown/code viewing, an improved voice-note (audio) player, and
client-side thumbnails in grid view.

Existing baseline: `web/preview.js` already previews images, audio, and video
in a dialog; the server (`src/server/server.js`) streams file content with
byte-range support and cookie session auth. PDFs currently fall back to
"download to open"; the file list shows only glyph icons.

## Approach

Approach B: one new module plus targeted extensions.

- `web/thumbnails.js` (new): sole owner of thumbnail generation, caching, and
  blob-URL lifecycle.
- `web/preview.js` (extended): per-type renderers (pdf, text, audio player).
- `web/app.js` (small change): grid view asks `thumbnails.js` for a URL,
  falls back to glyph icons. List view unchanged.
- `src/server/security.js`: inline allowlist additions and one CSP change.

No server route changes: the content endpoint already handles ranged,
authenticated streaming.

## Inline allowlist and CSP changes (`src/server/security.js`)

Add to the inline MIME set:

- `application/pdf`
- `text/plain`, `text/markdown`
- Code files: preview treats an entry as text if its stored mime is `text/*`
  OR its name ends in `.js`, `.ts`, `.json`, `.css`, `.sh`, or `.py`
  (browsers upload these with inconsistent or missing mime types; the
  catalog is not modified). Text files serve inline as `text/plain` when
  their stored mime is a text type; unknown/code mimes that the server
  would force to octet-stream keep attachment disposition for direct
  navigation but still preview as text in the dialog.
- Audio additions: `audio/mp4` (`.m4a`), `audio/ogg` (`.opus`, `.oga`),
  `audio/flac` already present.

CSP: `frame-src 'none'` → `frame-src 'self'`. `object-src 'none'`,
`script-src 'self'`, and `img-src 'self' blob:` stay unchanged.

`image/svg+xml` remains excluded (XSS). `text/html` remains excluded and
forced to attachment.

## PDF preview

`<iframe src="/api/files/<id>/content" title="<filename>">` inside the
existing preview dialog. The browser's built-in PDF viewer renders it;
content stays cookie-authenticated, ranged, and `no-store`. The download
button stays visible below the frame as a fallback.

## Text / markdown / code preview

Fetch content with session credentials, cap at the first 1 MB, render via
`textContent` into a `<pre>` (monospace styling). `.md` renders as plain
text — no markdown-to-HTML conversion (XSS surface, out of scope).

## Voice notes / audio player

Styled player over the native `<audio>` element (native controls retained
for accessibility): play/pause, seek bar, elapsed/total time, playback-speed
cycle (1× → 1.25× → 1.5× → 2×). No waveform rendering (full-file WebAudio
decode is rejected as too memory-heavy for large files).

## Thumbnails (grid view only)

- Images: `<img>` → `<canvas>` (capped ~320px) → `canvas.toBlob` → object URL.
- Video: hidden `<video preload="metadata">`, seek to `min(1s, 10% of
  duration)`, capture frame to canvas; timeout or error → glyph fallback.
- Only for mime types in the inline allowlist.
- In-memory `Map` cache keyed by entry id + size; blob URLs revoked on lock.
- `IntersectionObserver` gates generation to visible tiles; concurrency
  limit of ~3 simultaneous generations.

## Security invariants

- All filenames and text rendered with `textContent`; no `innerHTML`.
- SVG and HTML stay non-inline.
- Thumbnails exist only as in-memory blob URLs; nothing decrypted is written
  to disk (existing design constraint preserved).
- `Cache-Control: no-store` preserved on all responses; loopback binding and
  encrypted metadata untouched.

## Testing

- `test/server.test.js`: PDF and text mimes serve inline with correct
  Content-Type; `text/html` still forced to `application/octet-stream` +
  attachment; range behavior unchanged.
- `test/web.test.js` (Happy DOM): grid creates thumbnail elements for image
  entries (generation mocked at element level); preview dialog dispatches to
  pdf/text/audio renderers; lock clears thumbnails, dialog, and blob URLs.
  Per AGENTS.md, DOM tests do not verify rendering or media codecs.
- Manual verification for real codecs (video poster frames, PDF viewer).

## Out of scope

- Markdown-to-HTML rendering; waveform visualization; server-side thumbnail
  generation; list-view thumbnails; new catalog fields (no
  `docs/vault-format.md` change — mime is already stored).
