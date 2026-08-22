/**
 * TypeScript surface of docs/contracts/wasm-api.md (FROZEN).
 *
 * This file is types only. Two implementations satisfy it:
 *   - `wasm-mock.ts`  — the in-repo test double (pure TS, no wasm)
 *   - `wasm/`         — the real wasm-bindgen bundle produced by S7
 *
 * `optical.ts` is the single switch between them.
 */

export type Profile = "auto" | "L0" | "L1" | "L2" | "L3" | "L4";

export interface Manifest {
  totalBytes: number;
  chunkSize: number;
  chunkCount: number;
  /** false when the probe found the input incompressible (ADR-0006) */
  compressed: boolean;
  /** 6 chars, BLAKE3 — the human compares this across the two screens (ADR-0005) */
  displayCode: string;
}

export interface SenderOptions {
  profile?: Profile;
  /** ADR-0006 / S5: 256 KB. Do NOT shrink — 64 KB costs 10-11% compression. */
  chunkSize?: number;
  width?: number;
  height?: number;
}

export interface FrameView {
  ptr: number;
  len: number;
  width: number;
  height: number;
}

export interface SenderProgress {
  chunk: number;
  chunkCount: number;
  framesEmitted: number;
}

export interface OpticalSender {
  manifest(): Manifest;
  /** Next frame as RGBA, ready for ctx.putImageData. Endless by design (ADR-0005). */
  nextFrame(): FrameView;
  progress(): SenderProgress;
  setProfile(p: Profile): void;
  free(): void;
}

export interface PushResult {
  /** false = frame dropped. An ERASURE, not an error (ADR-0004). */
  accepted: boolean;
  reason?: "no_fiducials" | "bad_crc" | "duplicate";
  /** index of a chunk that just completed on this frame */
  chunkComplete?: number;
  /** the ADR-0005 integer the human reads off the screen */
  neededMore: number;
  /** 0..1, drives the alignment UI */
  quality: number;
}

export interface TakenChunk {
  index: number;
  ptr: number;
  len: number;
}

export interface OpticalReceiver {
  /** Borrow a buffer to write the camera frame into. No copy. */
  frameBuffer(): { ptr: number; len: number };
  pushFrame(): PushResult;
  manifest(): Manifest | null;
  neededMore(): number;
  resumeCode(): string;
  displayCode(): string | null;
  takeChunk(): TakenChunk | null;
  isComplete(): boolean;
  free(): void;

  /**
   * NOT IN THE FROZEN CONTRACT. The shipped wasm bundle exposes it, labelled
   * "test hook", and it is the only way to tell the decoder that a frame is
   * already aligned so it can skip fiducial detection and the homography.
   *
   * That is exactly what a screen capture needs: a pixel-perfect grab has no
   * perspective, no lens and no blur, and solving for a homography that is the
   * identity burns the large majority of decode CPU for nothing.
   *
   * Optional here because the mock has no geometry stage at all. If it is
   * missing, the caller must keep the geometry path and say so rather than
   * pretend the work was skipped.
   */
  setGeometry?(on: boolean): void;
}

export interface OpticalSenderCtor {
  create(bytes: Uint8Array, opts?: SenderOptions): OpticalSender;
}

export interface OpticalReceiverCtor {
  create(opts?: { width?: number; height?: number }): OpticalReceiver;
  /** haveChunks is a bitmap; each retained chunk is re-verified against manifest BLAKE3. */
  resume(
    code: string,
    manifest: Manifest,
    haveChunks: Uint8Array,
  ): OpticalReceiver | null;
}

/**
 * The module surface. Both implementations export exactly this, so switching
 * between them is one line in `optical.ts`.
 *
 * `memory` is the WASM linear memory (the mock exposes an object with the same
 * `.buffer` shape). Every ptr/len pair returned above indexes into it, and the
 * view must be re-taken after any call that may have grown memory.
 */
export interface OpticalModule {
  /** wasm-bindgen module init. The mock resolves immediately. */
  init(): Promise<void>;
  readonly memory: { buffer: ArrayBufferLike };
  readonly OpticalSender: OpticalSenderCtor;
  readonly OpticalReceiver: OpticalReceiverCtor;
  /** Which implementation is loaded, so the UI can say so rather than pretend. */
  readonly implementation: "mock" | "wasm";

  /**
   * NOT IN THE FROZEN CONTRACT. Payload bytes one frame carries at a given
   * profile and frame size.
   *
   * The UI needs this and cannot derive it. With a real fountain code the
   * stream never repeats — every frame is a distinct coded block — so you
   * cannot discover "how many frames is one pass" by watching for a repeat.
   * Without this call the app cannot tell a person how long a transfer will
   * take, or notice that their note fits in a single picture.
   */
  frameCapacity?(profile: Profile, width: number, height: number): number;
}
