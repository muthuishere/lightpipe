import type { Manifest } from "../wasm-api";

/** main -> worker */
export type ToWorker =
  | {
      type: "init";
      fileName: string;
      /**
       * false = the frames are known to be already aligned (a screen capture),
       * so the decoder may skip fiducial detection and the homography.
       */
      geometry: boolean;
      /**
       * ADR-0017 preflight. Measure the link and report per-check verdicts;
       * write nothing to disk and keep no state between runs.
       */
      doctor?: boolean;
      /** quality settings this engine can actually use, for the recommendation */
      profiles?: string[];
    }
  | { type: "frame"; bitmap: ImageBitmap }
  | { type: "stop" }
  | { type: "finish" };

export interface DecodeStats {
  /** frames handed to the decoder */
  framesSeen: number;
  /** frames the decoder accepted a new block from */
  accepted: number;
  /** frames that did not decode. ERASURES (ADR-0004), not failures. */
  erasures: number;
  duplicates: number;
  /** 0..1 cell separation from the last frame */
  quality: number;
  /** the ADR-0005 integer, or -1 while no header has decoded yet */
  neededMore: number;
  chunksComplete: number;
  chunkCount: number;
  bytesWritten: number;
  resumeCode: string;
  displayCode: string | null;
  manifest: Manifest | null;
  /** measured decode-side frame rate */
  fps: number;
  /** measured goodput, bytes of file per second */
  bytesPerSec: number;
  elapsedSec: number;
  complete: boolean;
  /** dominant failure reason while nothing is decoding */
  lastReason: string | null;
  /** is the decoder still solving for geometry, or sampling a known grid? */
  geometryOn: boolean;
  /** did the core actually honour the request to skip geometry? */
  geometrySkipSupported: boolean;
}

/** One named check from the ADR-0017 preflight. */
export interface DoctorCheck {
  id: "fiducials" | "sharpness" | "fill" | "exposure" | "colour" | "decode";
  label: string;
  /** null while there is not enough evidence yet */
  pass: boolean | null;
  /** the measured number, already formatted */
  reading: string;
  /** what to do about it, only when failing */
  remedy: string;
}

export interface DoctorReport {
  framesSeen: number;
  checks: DoctorCheck[];
  verdict: "good" | "workable" | "bad" | "measuring";
  summary: string;
  /** profile id recommended by measurement, not by guess */
  recommend: string | null;
}

/** worker -> main */
export type FromWorker =
  | { type: "ready" }
  | { type: "ack" }
  | { type: "stats"; stats: DecodeStats }
  | { type: "chunk"; index: number; bytesWritten: number }
  | { type: "complete"; stats: DecodeStats }
  | {
      /**
       * ADR-0011: a camera on which NOTHING decodes must fail loudly and fast
       * with actionable guidance, never hang at 0%.
       */
      type: "no-signal";
      guidance: string;
      framesTried: number;
      seconds: number;
    }
  | {
      /**
       * Geometry was switched off for a screen capture and nothing decoded, so
       * the frame was not the aligned grab we assumed. Turned back on.
       */
      type: "geometry-fallback";
      framesTried: number;
    }
  | { type: "doctor"; report: DoctorReport }
  | { type: "saved"; blob: Blob; fileName: string; size: number }
  | { type: "error"; message: string };
