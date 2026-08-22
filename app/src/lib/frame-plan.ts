/**
 * Choosing the frame the sender actually draws.
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * The core renders a fixed grid at a fixed cell size, so a 200-byte note went
 * into a frame with ~1,450 bytes of capacity and the surplus cells came out as
 * symbol-0 padding — black. On screen that is two thin blinking lines on a
 * black rectangle: it looks broken, and it is genuinely worse to read, because
 * the data occupies a strip instead of filling the viewfinder.
 *
 * Padding cells are meaningless — the decoder stops at the header's
 * payload_len — so the fix is to not have any. Filling them with a neutral
 * "ignore" colour would need a change inside the renderer, which lives in the
 * core. What the app CAN do through the frozen contract is pick a frame the
 * payload actually fills:
 *
 *   1. pick the COARSEST quality the payload can afford — big cells are both
 *      the most reliable to read and the right answer for small data;
 *   2. shrink the rendered frame until its capacity only just exceeds the
 *      payload, so almost every cell carries data;
 *   3. let CSS scale that small, dense grid up to fill the screen, which turns
 *      the shrink into visibly BIGGER cells rather than a smaller picture.
 *
 * A 200-byte note ends up as a dense edge-to-edge grid of fat cells. A large
 * file still gets the full-size dense frame, because it needs every cell.
 */
import type { OpticalModule, Profile } from "../wasm-api";

/**
 * Below this the core refuses to build a frame — the corner markers and their
 * quiet zone stop fitting. Measured against the shipped bundle: 634x356 still
 * renders at the coarsest quality, 480x270 does not.
 */
export const MIN_EDGE = 700;

/**
 * How long a single pass may get before we give up on bigger blocks.
 *
 * Deliberately generous: at 30 fps, 600 frames is 20 seconds of broadcast for
 * one pass, and a receiver that can actually READ the blocks finishes in one or
 * two passes. That is a far better outcome than a fast frame nothing resolves.
 */
const MAX_PASS_FRAMES = 600;

/** Coarsest (most reliable) first — the order "auto" walks. */
const LADDER: Profile[] = ["L0", "L1", "L2", "L3", "L4"];

export interface FramePlan {
  profile: Profile;
  width: number;
  height: number;
  /** payload bytes one of these frames carries */
  capacity: number;
  /** how many frames one full pass through the payload takes */
  framesPerPass: number;
  /** fraction of the frame's capacity the payload actually uses, 0..1 */
  fill: number;
  /** true when the frame was shrunk below full size to pack it densely */
  shrunk: boolean;
}

export interface PlanInput {
  totalBytes: number;
  /** what the user asked for; "auto" lets us walk the ladder */
  requested: Profile;
  baseWidth: number;
  baseHeight: number;
  /** rungs the engine actually round-trips; anything else is never chosen */
  usable?: Set<Profile>;
}

/**
 * `frameCapacity` is not in the frozen contract. Without it there is no way to
 * plan anything, so fall back to the full frame and the requested quality.
 */
export function planFrame(optical: OpticalModule, input: PlanInput): FramePlan {
  const { totalBytes, requested, baseWidth, baseHeight } = input;
  const cap = optical.frameCapacity;
  if (!cap) {
    return {
      profile: requested,
      width: baseWidth,
      height: baseHeight,
      capacity: 0,
      framesPerPass: 0,
      fill: 0,
      shrunk: false,
    };
  }

  const at = (p: Profile, w: number, h: number) => {
    try {
      return cap(p, w, h) || 0;
    } catch {
      return 0;
    }
  };

  // 1. Coarsest quality that keeps one pass short enough to be worth watching.
  let profile = requested;
  if (requested === "auto") {
    const usable = input.usable;
    const ladder = usable ? LADDER.filter((p) => usable.has(p)) : LADDER;
    if (ladder.length === 0) {
      // Nothing on the ladder works; hand back the engine's own default rather
      // than pick a rung we know decodes nothing.
      profile = "auto";
    } else {
      profile = ladder[ladder.length - 1];
      for (const p of ladder) {
        const c = at(p, baseWidth, baseHeight);
        if (c > 0 && Math.ceil(totalBytes / c) <= MAX_PASS_FRAMES) {
          profile = p;
          break;
        }
      }
    }
  }

  const fullCap = at(profile, baseWidth, baseHeight);
  let width = baseWidth;
  let height = baseHeight;
  let capacity = fullCap;
  let shrunk = false;

  // 2. If it fits in one frame with room to spare, shrink until it does not.
  //    A little headroom so the fountain's own per-packet overhead still fits.
  const target = Math.ceil(totalBytes * 1.06) + 64;
  if (fullCap > target) {
    const aspect = baseHeight / baseWidth;
    let lo = MIN_EDGE;
    let hi = Math.max(baseWidth, baseHeight);
    // binary search on the LONG edge
    const long = () => (baseWidth >= baseHeight ? baseWidth : baseHeight);
    void long;
    const dimsFor = (longEdge: number) =>
      baseWidth >= baseHeight
        ? { w: longEdge, h: Math.round(longEdge * aspect) }
        : { w: Math.round(longEdge / (baseHeight / baseWidth)), h: longEdge };
    let best: { w: number; h: number; c: number } | null = null;
    for (let i = 0; i < 14 && lo <= hi; i++) {
      const mid = Math.round((lo + hi) / 2);
      const d = dimsFor(mid);
      const c = at(profile, d.w, d.h);
      if (c >= target) {
        best = { ...d, c };
        hi = mid - 8;
      } else {
        lo = mid + 8;
      }
    }
    if (best && best.w < baseWidth && best.h < baseHeight) {
      width = best.w - (best.w % 2);
      height = best.h - (best.h % 2);
      capacity = at(profile, width, height);
      if (capacity < target) {
        // The rounding cost us the fit. Keep the full frame rather than ship a
        // frame that silently needs a second pass.
        width = baseWidth;
        height = baseHeight;
        capacity = fullCap;
      } else {
        shrunk = true;
      }
    }
  }

  const framesPerPass = capacity > 0 ? Math.max(1, Math.ceil(totalBytes / capacity)) : 0;
  return {
    profile,
    width,
    height,
    capacity,
    framesPerPass,
    fill: capacity > 0 ? Math.min(1, totalBytes / (capacity * framesPerPass)) : 0,
    shrunk,
  };
}



/**
 * What fraction of the frame carries data?
 *
 * `frameCapacity` reports what the core says a frame holds, and that is not the
 * same as what it DRAWS: on a small payload the grid comes out as a band and
 * the rest of the frame is black. Measure the real thing — count pixels that
 * are neither background white nor dead black, straight out of wasm memory.
 */
function inkFraction(
  optical: OpticalModule,
  sender: { nextFrame: () => { ptr: number; len: number } },
): number {
  const f = sender.nextFrame();
  const px = new Uint8Array(optical.memory.buffer as ArrayBuffer, f.ptr, f.len);
  let lit = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 64) {
    n++;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const dark = r < 40 && g < 40 && b < 40;
    const pale = r > 215 && g > 215 && b > 215;
    if (!dark && !pale) lit++;
  }
  return n ? lit / n : 0;
}

/* ----------------------------------------------------------- capability probe */

/**
 * Which quality settings does the loaded engine ACTUALLY round-trip?
 *
 * Measured against the shipped wasm bundle: only L3 (what "auto" resolves to)
 * decodes. L0, L1, L2 and L4 render a frame and report a sensible
 * `frameCapacity`, and the receiver then rejects every one — 0 accepted out of
 * 80, at any frame size or aspect. Nothing in the contract exposes this, so the
 * app cannot know it without trying.
 *
 * A control that silently does nothing is worse than one that is not there, so
 * the app probes once and only offers what works. When the core is fixed the
 * extra rungs light up on their own.
 */
export function probeProfiles(optical: OpticalModule): Set<Profile> {
  const working = new Set<Profile>();
  const payload = new Uint8Array(240).fill(65);
  for (const p of ["auto", ...LADDER] as Profile[]) {
    let sender: { nextFrame: () => { ptr: number; len: number }; free: () => void } | null = null;
    let rx: ReturnType<OpticalModule["OpticalReceiver"]["create"]> | null = null;
    try {
      sender = optical.OpticalSender.create(payload, { profile: p, width: 1920, height: 1080 });
      rx = optical.OpticalReceiver.create({ width: 1920, height: 1080 });
      rx.setGeometry?.(false);
      const fb = rx.frameBuffer();
      for (let i = 0; i < 6 && !rx.isComplete(); i++) {
        const f = sender.nextFrame();
        new Uint8Array(optical.memory.buffer as ArrayBuffer, fb.ptr, fb.len).set(
          new Uint8Array(optical.memory.buffer as ArrayBuffer, f.ptr, f.len),
        );
        rx.pushFrame();
        let taken = rx.takeChunk();
        while (taken) taken = rx.takeChunk();
      }
      if (rx.isComplete()) working.add(p);
    } catch {
      /* this rung cannot even be built */
    } finally {
      sender?.free();
      rx?.free();
    }
  }
  if (working.size === 0) working.add("auto");
  return working;
}

/* ------------------------------------------------------------------ fitting */

/**
 * WHAT WE ARE ACTUALLY OPTIMISING — and what the first version got wrong.
 *
 * The first version maximised how much of the FRAME carried data. That is the
 * wrong objective, and a screenshot of a real desktop send showed why: a
 * portrait frame letterboxed onto a 1920x1080 screen, code occupying the middle
 * 25%, both side thirds pure black. The frame was well filled. The SCREEN was
 * not, and the camera does not see the frame — it sees the screen.
 *
 * The camera has to hold all four corner markers in view, so it frames the
 * whole code. Whatever fraction of the display the code fails to cover is
 * magnification thrown away, and it comes straight off the cell size landing on
 * the sensor. 145 frames sent, zero read.
 *
 * The right objective is CELL PITCH IN PHYSICAL SCREEN PIXELS:
 *
 *     screenPitch = cellPx * (viewportWidth / frameWidth)
 *
 * Two consequences, both the opposite of what the old code did:
 *   - the frame's aspect must MATCH the display's, so `object-fit: contain`
 *     scales it edge to edge instead of letterboxing it;
 *   - the frame should be as SMALL in pixels as the payload allows, because a
 *     smaller frame is scaled up harder and every cell gets bigger. A small
 *     frame blown up is exactly what we want, not a big frame centred.
 *
 * Cell pitch is measured off a rendered frame rather than assumed, because the
 * contract does not expose it.
 */

/** Longest edge candidates, SMALLEST first — smaller frame, bigger cells. */
const EDGES = [640, 700, 760, 840, 920, 1000, 1120, 1280, 1440, 1680, 1920];

/**
 * Cell pitch of a rendered frame, in frame pixels.
 *
 * Scans rows inside the payload band and takes the median run length of an
 * unchanging colour. Runs of 1 are noise and the long black tail is dead space,
 * so both are excluded.
 */
function measureCellPitch(
  optical: OpticalModule,
  sender: { nextFrame: () => { ptr: number; len: number; width: number; height: number } },
): number {
  const f = sender.nextFrame();
  const px = new Uint32Array(optical.memory.buffer as ArrayBuffer, f.ptr, f.len >> 2);
  const runs: number[] = [];
  const rows = 24;
  for (let k = 1; k <= rows; k++) {
    const y = Math.floor((f.height * k) / (rows + 1));
    const base = y * f.width;
    let run = 1;
    for (let x = 1; x < f.width; x++) {
      if (px[base + x] === px[base + x - 1]) {
        run++;
      } else {
        if (run > 1 && run < f.width / 4) runs.push(run);
        run = 1;
      }
    }
  }
  if (runs.length === 0) return 0;
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

/**
 * Does this frame actually carry its four corner markers?
 *
 * THE TRAP. Below some frame size the core silently omits the fiducials: at
 * 700x345 every corner measures 0% white / 98% black, while 840x414 and up show
 * the bullseye (~40% white / 58% black). A frame without markers cannot be
 * rectified, so a camera can never read it — and the failure is invisible to
 * any test that decodes with the geometry stage switched off, which is exactly
 * how the loopback path runs.
 *
 * Nothing in the contract exposes a minimum, so measure it. A candidate that
 * cannot show its corners is rejected however good its cell pitch looks.
 */
function hasFiducials(
  optical: OpticalModule,
  sender: { nextFrame: () => { ptr: number; len: number; width: number; height: number } },
): boolean {
  const f = sender.nextFrame();
  const px = new Uint8Array(optical.memory.buffer as ArrayBuffer, f.ptr, f.len);
  const box = Math.min(120, Math.floor(Math.min(f.width, f.height) / 4));
  const corner = (x0: number, y0: number) => {
    let white = 0;
    let n = 0;
    for (let y = y0; y < y0 + box && y < f.height; y++) {
      for (let x = x0; x < x0 + box && x < f.width; x++) {
        const i = (y * f.width + x) * 4;
        n++;
        if (px[i] > 215 && px[i + 1] > 215 && px[i + 2] > 215) white++;
      }
    }
    // A bullseye on its quiet zone is roughly 40% white. Anything under 15% is
    // an empty corner.
    return n > 0 && white / n > 0.15;
  };
  return (
    corner(0, 0) &&
    corner(f.width - box, 0) &&
    corner(0, f.height - box) &&
    corner(f.width - box, f.height - box)
  );
}

export interface DisplayPlanInput {
  totalBytes: number;
  requested: Profile;
  usable?: Set<Profile>;
  /** the area the canvas will actually be displayed in, in CSS pixels */
  viewW: number;
  viewH: number;
}

export interface DisplayPlan extends FramePlan {
  /** cell pitch in frame pixels, measured off a real render */
  cellPx: number;
  /** cell pitch in physical display pixels — the number a camera cares about */
  screenPitch: number;
  /** how much of the display area the frame covers once scaled, 0..1 */
  screenCoverage: number;
}

/**
 * Pick the frame that puts the BIGGEST CELLS on the glass.
 *
 * Aspect always matches the display, so nothing is letterboxed. Then, per
 * usable quality, take the smallest frame the payload fits in — that is the one
 * scaled up hardest — and keep whichever combination measures the largest cell
 * pitch on screen.
 */
export function planForDisplay(
  optical: OpticalModule,
  payload: Uint8Array,
  input: DisplayPlanInput,
): DisplayPlan {
  const { totalBytes, requested, viewW, viewH } = input;
  const aspect = viewW / Math.max(1, viewH);
  const landscape = aspect >= 1;
  const cap = optical.frameCapacity;

  const fallback: DisplayPlan = {
    profile: requested === "auto" ? "auto" : requested,
    width: landscape ? 1920 : 1080,
    height: landscape ? 1080 : 1920,
    capacity: 0,
    framesPerPass: 0,
    fill: 0,
    shrunk: false,
    cellPx: 0,
    screenPitch: 0,
    screenCoverage: 1,
  };
  if (!cap) return fallback;

  const ladder =
    requested === "auto"
      ? (input.usable ? LADDER.filter((p) => input.usable!.has(p)) : LADDER)
      : [requested];
  if (ladder.length === 0) ladder.push("auto");

  // A little headroom for the fountain's own per-packet overhead.
  const target = Math.ceil(totalBytes * 1.06) + 64;

  let best: DisplayPlan | null = null;

  for (const profile of ladder) {
    for (const edge of EDGES) {
      const w = landscape ? edge : Math.round(edge * aspect);
      const h = landscape ? Math.round(edge / aspect) : edge;
      if (Math.min(w, h) < 300) continue;

      let capacity = 0;
      try {
        capacity = cap(profile, w, h) || 0;
      } catch {
        continue;
      }
      if (capacity <= 0) continue;

      const framesPerPass = Math.max(1, Math.ceil(totalBytes / capacity));
      /**
       * BIGGER BLOCKS WIN, and it is not a close trade.
       *
       * A cell too small for the camera to resolve does not make the transfer
       * slow — it makes it never finish. A cell twice as wide costs roughly 4x
       * the frames, which is seconds. So we accept a much longer pass in
       * exchange for a larger pitch, and only refuse when the pass becomes
       * genuinely unreasonable.
       */
      if (framesPerPass > MAX_PASS_FRAMES && edge !== EDGES[EDGES.length - 1]) continue;
      void target;

      let probe:
        | {
            nextFrame: () => { ptr: number; len: number; width: number; height: number };
            free: () => void;
          }
        | null = null;
      try {
        probe = optical.OpticalSender.create(payload, { profile, width: w, height: h });
        // A frame without corner markers is unreadable by any camera, however
        // large its cells look. Reject before scoring.
        if (!hasFiducials(optical, probe)) continue;
        const cellPx = measureCellPitch(optical, probe);
        const ink = inkFraction(optical, probe);
        // object-fit: contain — the frame scales until one axis is full.
        const scale = Math.min(viewW / w, viewH / h);
        const screenPitch = cellPx * scale;
        const screenCoverage = ((w * scale) * (h * scale)) / Math.max(1, viewW * viewH);
        const candidate: DisplayPlan = {
          profile,
          width: w,
          height: h,
          capacity,
          framesPerPass,
          fill: ink,
          shrunk: w < 1920 && h < 1920,
          cellPx,
          screenPitch,
          screenCoverage,
        };
        if (!best || screenPitch > best.screenPitch) best = candidate;
        // Smallest-first, and smaller is always a bigger pitch, so the first
        // size that works for this rung is the best this rung can do.
        break;
      } catch {
        /* the core will not build this frame; try the next size up */
      } finally {
        probe?.free();
      }
    }
  }

  return best ?? fallback;
}
