# ADR-0008: OPFS for large-file streaming, not the File System Access API

Status: Accepted · 2026-08-22

## Context
Files may be multi-GB. Buffering in memory is not an option, and fountain decoding
writes blocks **out of order**, so the sink needs random access.

## Decision
Receive into the **Origin Private File System** via
`navigator.storage.getDirectory()` → `createSyncAccessHandle()` inside a Worker,
using `handle.write(chunk, { at: byteOffset })`. Hand the user a normal download at
the end. `showSaveFilePicker()` stays as a Chromium-only fast path.

Send side reads via `file.stream()` piped through `new CompressionStream('gzip')` —
never `readAsArrayBuffer` on a large file.

## Consequences
- Cross-browser: OPFS sync access handles work in Chrome, Firefox and Safari.
  `showSaveFilePicker()` is Chromium-only and cannot be the primary path for a
  browser-only product.
- Seekable random-access writes are exactly what out-of-order fountain output needs —
  the API fits the algorithm rather than fighting it.
- Zero heap pressure on multi-GB transfers.
- Browser storage quota applies; must be checked before starting and surfaced.

## Verification
Browser-API support must be re-checked at build time — this ADR records the state as
understood in Aug 2026 and browser support moves.
