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
