/**
 * How long will this take?
 *
 * The sender has no back-channel (ADR-0005), so it can never know the
 * receiver's actual rate. What it CAN do is quote the two measured ends of the
 * range and let the human decide before they commit to holding a camera still.
 *
 * Both endpoints are measured, not guessed — S4's warped clean-decode frontier
 * (docs/spikes/PLAN.md, and the revised table in ADR-0011) at 15 FPS:
 *
 *   good / webcam, hand-held   P8 @ 8px   8,748 B/frame  = 131.2 KB/s
 *   potato,        hand-held   P8 @ 20px  1,182 B/frame  =  17.7 KB/s
 *
 * The potato figure is the one that matters: ADR-0011 promises it completes,
 * and this is the price of that promise.
 */

export const CAMERA_FPS = 15;
export const GOOD_B_PER_FRAME = 8748;
export const POTATO_B_PER_FRAME = 1182;
export const GOOD_BPS = GOOD_B_PER_FRAME * CAMERA_FPS;
export const POTATO_BPS = POTATO_B_PER_FRAME * CAMERA_FPS;

/** Anything slower than this at the optimistic end is worth a warning. */
export const IMPRACTICAL_SECONDS = 600;

export interface Estimate {
  bytes: number;
  framesGood: number;
  framesPotato: number;
  secondsBest: number;
  secondsWorst: number;
  /** fits in a single frame even on the coarsest measured rung */
  singleFrame: boolean;
  impractical: boolean;
}

export function estimate(totalBytes: number): Estimate {
  const framesGood = Math.max(1, Math.ceil(totalBytes / GOOD_B_PER_FRAME));
  const framesPotato = Math.max(1, Math.ceil(totalBytes / POTATO_B_PER_FRAME));
  return {
    bytes: totalBytes,
    framesGood,
    framesPotato,
    secondsBest: framesGood / CAMERA_FPS,
    secondsWorst: framesPotato / CAMERA_FPS,
    singleFrame: totalBytes <= POTATO_B_PER_FRAME,
    impractical: framesGood / CAMERA_FPS > IMPRACTICAL_SECONDS,
  };
}
