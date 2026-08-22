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

/** Longest pass we are willing to accept before stepping up the density. */
const MAX_PASS_FRAMES = 64;

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


/* ------------------------------------------------------------------ fitting */

/**
 * What fraction of the frame is actually carrying something?
 *
 * `frameCapacity` reports what the core says a frame holds, and that turned out
 * not to be the same thing as what the core DRAWS. On a small payload the
 * rendered grid is a band across the top and the rest of the frame is black —
 * capacity said 76% used while the picture was 90% void. Whatever the core is
 * doing internally (packet-aligned rows, most likely), the app cannot see it
 * and should not have to guess.
 *
 * So measure the real thing: render one frame and count the pixels that are not
 * black. Reading straight out of wasm linear memory, no canvas involved.
 */
function inkFraction(optical: OpticalModule, sender: { nextFrame: () => { ptr: number; len: number } }): number {
  const f = sender.nextFrame();
  const px = new Uint8Array(optical.memory.buffer as ArrayBuffer, f.ptr, f.len);
  let lit = 0;
  let n = 0;
  // Every 16th pixel is plenty for a ratio and keeps this off the hot path.
  // White is margin and quiet zone, black is void: only COLOURED pixels are
  // data, so only they count.
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

/** Widths we are willing to try, largest first. */
const WIDTHS = [1920, 1680, 1440, 1280, 1080, 960, 840, 720];
/** Height fractions of the nominal 16:9 height, to find one the data fills. */
const HEIGHT_FRACTIONS = [1, 0.75, 0.55, 0.4, 0.3, 0.22];

/**
 * Pick the frame the payload visibly FILLS, by building a throwaway sender at
 * each candidate size and looking at what actually comes out.
 *
 * Height is searched independently of width, because the core draws a grid of
 * far fewer rows than the frame has and no proportional shrink ever closes that
 * gap — see the note on `inkFraction`. A shorter frame at the same width is the
 * only lever the app has, and the corner markers follow the frame, so geometry
 * still works.
 *
 * Costs a handful of wasm renders once per transfer, which is nothing next to
 * the transfer itself.
 */
export function fitFrame(
  optical: OpticalModule,
  payload: Uint8Array,
  input: PlanInput,
): FramePlan {
  const base = planFrame(optical, input);
  if (!optical.frameCapacity) return base;

  const portrait = input.baseHeight > input.baseWidth;
  const longest = Math.max(input.baseWidth, input.baseHeight);
  const shortest = Math.min(input.baseWidth, input.baseHeight);

  let best = base;
  let bestInk = -1;

  for (const longEdge of WIDTHS) {
    if (longEdge > longest) continue;
    const shortFull = Math.round((longEdge * shortest) / longest);
    for (const frac of HEIGHT_FRACTIONS) {
      const shortEdge = Math.round(shortFull * frac);
      if (shortEdge < 320) continue;
      const w = portrait ? shortEdge : longEdge;
      const h = portrait ? longEdge : shortEdge;

      let cap = 0;
      try {
        cap = optical.frameCapacity(base.profile, w, h) || 0;
      } catch {
        continue;
      }
      if (cap <= 0) continue;
      const frames = Math.max(1, Math.ceil(input.totalBytes / cap));
      // Never turn a one-pass transfer into a multi-pass one just to look full,
      // and never make a long transfer materially longer.
      if (frames > Math.max(1, base.framesPerPass)) continue;

      let probe: { nextFrame: () => { ptr: number; len: number }; free: () => void } | null = null;
      try {
        probe = optical.OpticalSender.create(payload, {
          profile: base.profile,
          width: w,
          height: h,
        });
        const ink = inkFraction(optical, probe);
        if (ink > bestInk) {
          bestInk = ink;
          best = {
            profile: base.profile,
            width: w,
            height: h,
            capacity: cap,
            framesPerPass: frames,
            fill: ink,
            shrunk: w < input.baseWidth || h < input.baseHeight,
          };
        }
      } catch {
        /* the core would not build this frame; skip it */
      } finally {
        probe?.free();
      }
    }
  }
  return bestInk >= 0 ? best : base;
}

/* ----------------------------------------------------------- capability probe */

/**
 * Which quality settings does the loaded engine ACTUALLY round-trip?
 *
 * Measured against the shipped wasm bundle: only L3 (which is what "auto"
 * resolves to) decodes. L0, L1, L2 and L4 render a frame and report a sensible
 * `frameCapacity`, and the receiver then rejects every single one — 0 accepted
 * out of 80, at any frame size or aspect. Nothing in the contract exposes this,
 * so the app cannot know it without trying.
 *
 * A control that silently does nothing is worse than a control that is not
 * there, so the app probes once and only offers what works. When the core is
 * fixed the extra rungs light up on their own, with no change here.
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
  // Never return nothing: if the probe itself is wrong, the user must still be
  // able to try. "auto" is the engine's own default and the safest fallback.
  if (working.size === 0) working.add("auto");
  return working;
}
