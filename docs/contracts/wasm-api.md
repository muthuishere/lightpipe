# WASM ↔ JS API contract

Frozen so the wasm crate (S7) and the React app (S8) can be built in parallel.
Both sides code against this; if it must change, change it here first.

## Design rules
- **Zero-copy on the hot path.** Camera frames are written straight into WASM linear
  memory; JS gets back a pointer+length view, never a serialised array (ADR-0007).
- All heavy work is synchronous inside WASM. Concurrency is the caller's job
  (a Worker), because OPFS sync access handles require a Worker anyway (ADR-0008).
- No panics across the boundary. Every fallible call returns `null`/`false`.

## Sender

```ts
type Profile = "auto" | "L0" | "L1" | "L2" | "L3" | "L4";

class OpticalSender {
  static create(bytes: Uint8Array, opts?: {
    profile?: Profile;      // default "auto"
    chunkSize?: number;     // default 262144  (ADR-0006: 256 KB, do not shrink
                            // without re-running S5 — 64 KB costs 10-11%)
    width?: number;         // frame px, default 1920
    height?: number;        // default 1080
  }): OpticalSender;

  manifest(): {
    totalBytes: number; chunkSize: number; chunkCount: number;
    compressed: boolean;    // false when the probe found the input incompressible
    displayCode: string;    // 6 chars, BLAKE3 — the human compares this
  };

  /** Next frame, as RGBA ready for ctx.putImageData. Endless (ADR-0005). */
  nextFrame(): { ptr: number; len: number; width: number; height: number };

  progress(): { chunk: number; chunkCount: number; framesEmitted: number };

  /** Drop layers the receiver does not need (the optional ADR-0005 rate digit). */
  setProfile(p: Profile): void;
  free(): void;
}
```

## Receiver

```ts
class OpticalReceiver {
  static create(opts?: { width?: number; height?: number }): OpticalReceiver;

  /** Borrow a buffer to write the camera frame into. No copy. */
  frameBuffer(): { ptr: number; len: number };

  /** Decode whatever is currently in frameBuffer(). */
  pushFrame(): {
    accepted: boolean;        // false = frame dropped (erasure). Normal, not an error.
    reason?: "no_fiducials" | "bad_crc" | "duplicate";
    chunkComplete?: number;   // index of a chunk that just completed
    neededMore: number;       // the ADR-0005 integer the human reads
    quality: number;          // 0..1, drives the alignment UI
  };

  manifest(): Manifest | null;   // null until the first header decodes
  neededMore(): number;
  resumeCode(): string;          // 4-9 chars, Crockford base32 + check char
  displayCode(): string | null;  // compare with the sender's
  /** Completed chunk, for the caller to write at chunkIndex*chunkSize via OPFS. */
  takeChunk(): { index: number; ptr: number; len: number } | null;
  isComplete(): boolean;
  free(): void;
}
```

## Resume
`OpticalReceiver.resume(code: string, manifest: Manifest, haveChunks: Uint8Array)`
— `haveChunks` is a bitmap. Verified per-chunk against manifest BLAKE3 (S5 proved a
retained chunk can be re-verified off disk without re-fetching).

---

## Implementation notes (S7, 2026-08-22)

Built as `crates/wasm` (`optical-wasm`), bundled to `app/src/wasm/` by
`wasm-pack build --target web`. `harness/run.mjs` runs the whole chain through the
compiled wasm in Node — 62 checks, no browser. Everything below is what the frozen
contract did not say and someone had to decide.

### Implemented exactly as written
`OpticalSender.create/manifest/nextFrame/progress/setProfile/free` and
`OpticalReceiver.create/frameBuffer/pushFrame/manifest/neededMore/resumeCode/
displayCode/takeChunk/isComplete/free`, with the field names and shapes given above.
Returns are plain JS objects (built with `Reflect.set`), not wasm-bindgen classes, so
they spread, destructure and `JSON.stringify` the way the type signatures imply.
Fallible calls return `null`/`false`; nothing panics across the boundary
(`panic = "abort"` in the release build, so a panic would kill the page).

### Additions the contract needs but does not have
* **`OpticalSender.manifestBytes(): Uint8Array`** — the manifest is not carried in
  the 25-byte frame header (`header.rs` has room only for magic/version/seq/
  payload_len/oti). It is broadcast as a **pseudo-chunk** with `seq == 0xFFFFFFFF`,
  fountain-coded like any other chunk: a burst up front, then one frame in 24. This
  is what makes the receiver's `manifest()` go non-null "once the first header
  decodes". `manifestBytes()` is the same blob, for the caller to persist.
* **`OpticalReceiver.verifyChunk(index, plain): boolean`** — resume verification
  needs the chunk bytes, and the chunk bytes live in OPFS on the JS side (ADR-0008).
  wasm cannot read them, so the caller re-reads each retained chunk and asks wasm to
  check it against the manifest BLAKE3. That is how an honest `haveChunks` bitmap is
  built; the harness does exactly this.
* **`setGeometry(bool)` / `setFiducials(bool)`** — test hooks, off the hot path.
* **`benchNoop/benchNoopArg/benchFrameObject/checksumAt/frameCapacity`** and
  `benchPush/benchFrames/benchGeometry` — measurement only. `checksumAt` is how the
  harness proves the zero-copy claim rather than asserting it.

### Divergence
`OpticalReceiver.resume(code, manifest, haveChunks)` takes **`manifest` as the
`Uint8Array` from `manifestBytes()`**, not the summary object `manifest()` returns.
The summary has no per-chunk hashes, so it cannot support the per-chunk BLAKE3
verification this section requires. Signature is
`resume(code, manifestBytes, haveChunks, opts)`, `opts` matching `create`.
`haveChunks` is LSB-first. Returns `null` if the code fails its check character or
the manifest does not parse.

### Frame buffers
`frameBuffer()` and `nextFrame()` hand out pointers into buffers allocated once at
`create` and rewritten in place — the addresses are stable for the object's life, and
500 consecutive `nextFrame()` calls grow linear memory by 0 bytes. `frameBuffer()` is
RGBA `w*h*4`, i.e. `ImageData.data` laid out for `putImageData`. `takeChunk()` bytes
are valid until the next `takeChunk()`; copy them out before calling again.

### Profiles
`"auto"` = `L3` = P8 @ 8 px, which `artifacts/s4-frontier.csv` measures at SER 0 and
8,748 B/frame for both `good+warp` and `webcam+warp`. `L0` = 20 px (the ADR-0011
potato rung, 1,182 B/frame), `L1` 14, `L2` 10, `L4` 6. All rungs are P8: after S4 the
potato reads P8 @ 20 px cleanly, so dropping to P4/P2 buys nothing. `setProfile`
rebuilds the fountains (the symbol size changes with capacity) and returns `false`
rather than throwing if the profile will not fit the frame.

### Costs, measured (Node 24, M-series mac)
Median of 5 runs each, idle machine.

| | `opt-level=3` (shipped) | `opt-level="z"` |
|---|---|---|
| wasm, gzipped | **219.3 KB** (414,486 B raw) | 200.7 KB (356,227 B raw) |
| aligned decode @1920×1080 | **0.55 ms = 1,816 FPS** | 0.66 ms = 1,506 FPS |
| render a frame @1920×1080 | **3.36 ms = 297 FPS** | 6.35 ms = 157 FPS |
| decode + rectify | **76.5 ms = 13.1 FPS** | 161.5 ms = 6.2 FPS |

`opt-level="z"` buys 18.6 KB gzipped (8.5%) and costs **2.1× on the geometry path**,
which is the one path that is already too slow. ADR-0007's stated mitigation
("`opt-level=z` + `wasm-opt` at release") is the wrong trade here: ship `opt-level=3`
with `wasm-opt -Oz`, which is what `wasm-pack build --release` produces against this
workspace's root profile and what `app/src/wasm/` currently holds.
`harness/build.sh` builds the `-Oz` variant if the size ever matters more.

The JS↔WASM crossing costs **~0.7–1.3 µs/frame** (0.2% of one frame's decode), of
which ~0.72 µs is building the `{ptr,len,width,height}` return object; a bare call is
2.3 ns. Zero pixel bytes cross. The rectification path is the real constraint on S8,
not the boundary.
