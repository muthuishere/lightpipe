/**
 * The ADR-0017 preflight doctor, receiver half.
 *
 * WHY IT EXISTS. The first real-camera test produced 385 frames seen, 385
 * unreadable, nothing decoded — with all four fiducials correctly framed. The
 * real causes (focus pinned to manual, so the image was smeared, and a mostly
 * black sparse frame) were invisible from inside the app and took a photograph
 * of the phone to diagnose. A transfer that fails silently for six minutes is
 * worse than one that refuses to start.
 *
 * So: measure the link on a static pattern, name each check, and give a
 * specific remedy rather than a paragraph of guesses.
 *
 * Every number here is measured off the captured frame. Where a check cannot be
 * measured honestly it says so instead of inventing a value — in particular
 * SYMBOL ERROR RATE is not computed: the wasm contract exposes no per-symbol
 * comparison, so this reports the decoder's own accept rate on real frames,
 * which is an honest proxy and is labelled as one.
 */
import type { DoctorCheck, DoctorReport } from "./protocol";

export interface FrameMetrics {
  meanLuma: number;
  clipped: number;
  sharpness: number;
  fill: number;
  colour: number;
}

/**
 * All five image measurements in ONE pass over a subsample of the frame.
 * Runs per captured frame, so it has to be cheap: every 4th pixel on every 4th
 * row is far more than enough for statistics like these.
 */
export function measureFrame(px: Uint8Array, w: number, h: number): FrameMetrics {
  let lumaSum = 0;
  let clipped = 0;
  let n = 0;
  let gradSum = 0;
  let gradN = 0;
  let colourSum = 0;
  let colourN = 0;
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;

  const step = 4;
  for (let y = 0; y < h; y += step) {
    const row = y * w;
    for (let x = 0; x < w; x += step) {
      const i = (row + x) * 4;
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      const luma = (r * 299 + g * 587 + b * 114) / 1000;
      lumaSum += luma;
      if (luma > 250 || luma < 4) clipped++;
      n++;

      // Sharpness: mean absolute luma step to the neighbour one sample right.
      // A focused cell grid has hard edges; a smeared one does not.
      if (x + step < w) {
        const j = (row + x + step) * 4;
        const l2 = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
        gradSum += Math.abs(luma - l2);
        gradN++;
      }

      // Colour separation: how close each lit sample sits to a true RGB-cube
      // corner (ADR-0003). Washed-out colour lands in the middle instead.
      const isBg = (r < 40 && g < 40 && b < 40) || (r > 215 && g > 215 && b > 215);
      if (!isBg) {
        const d =
          Math.min(r, 255 - r) + Math.min(g, 255 - g) + Math.min(b, 255 - b);
        colourSum += 1 - d / 382.5; // 0 = mush, 1 = clean corner
        colourN++;
      }

      // Fill: the bounding box of everything that is not plain background.
      if (!(r > 215 && g > 215 && b > 215)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const area = maxX >= 0 ? ((maxX - minX) * (maxY - minY)) / (w * h) : 0;
  return {
    meanLuma: n ? lumaSum / n : 0,
    clipped: n ? clipped / n : 0,
    // Normalised against a hard black/white edge; 1.0 would be a perfect step.
    sharpness: gradN ? Math.min(1, gradSum / gradN / 64) : 0,
    fill: Math.max(0, Math.min(1, area)),
    colour: colourN ? colourSum / colourN : 0,
  };
}

export interface DoctorState {
  frames: number;
  pushed: number;
  accepted: number;
  sawFiducials: number;
  sum: FrameMetrics;
}

export function newDoctorState(): DoctorState {
  return {
    frames: 0,
    pushed: 0,
    accepted: 0,
    sawFiducials: 0,
    sum: { meanLuma: 0, clipped: 0, sharpness: 0, fill: 0, colour: 0 },
  };
}

export function accumulate(st: DoctorState, m: FrameMetrics) {
  st.frames++;
  st.sum.meanLuma += m.meanLuma;
  st.sum.clipped += m.clipped;
  st.sum.sharpness += m.sharpness;
  st.sum.fill += m.fill;
  st.sum.colour += m.colour;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function buildReport(st: DoctorState, profiles: string[]): DoctorReport {
  const n = Math.max(1, st.frames);
  const avg = {
    meanLuma: st.sum.meanLuma / n,
    clipped: st.sum.clipped / n,
    sharpness: st.sum.sharpness / n,
    fill: st.sum.fill / n,
    colour: st.sum.colour / n,
  };
  const enough = st.frames >= 8;
  const fiducialRate = st.pushed ? st.sawFiducials / st.pushed : 0;
  const acceptRate = st.pushed ? st.accepted / st.pushed : 0;

  const checks: DoctorCheck[] = [
    {
      id: "fiducials",
      label: "Corner markers",
      pass: !enough ? null : fiducialRate > 0.5,
      reading: enough ? `found in ${pct(fiducialRate)} of frames` : "measuring…",
      remedy: "Aim so the whole code is in view, with a margin all round.",
    },
    {
      id: "sharpness",
      label: "Focus",
      pass: !enough ? null : avg.sharpness > 0.18,
      reading: enough ? `edge contrast ${avg.sharpness.toFixed(2)}` : "measuring…",
      remedy:
        "The picture is smeared. Switch the camera to Autofocus in Setup — a pinned focus sits at the wrong distance and is the single most common cause of this.",
    },
    {
      id: "fill",
      label: "Framing",
      pass: !enough ? null : avg.fill > 0.35,
      reading: enough ? `code fills ${pct(avg.fill)} of the view` : "measuring…",
      remedy: "Move closer until the code fills most of the frame.",
    },
    {
      id: "exposure",
      label: "Brightness",
      pass: !enough ? null : avg.meanLuma > 25 && avg.meanLuma < 235 && avg.clipped < 0.25,
      reading: enough
        ? `mean ${avg.meanLuma.toFixed(0)}/255, ${pct(avg.clipped)} clipped`
        : "measuring…",
      remedy:
        "Too bright or too dark. Kill any glare or reflection on the sending screen and even out the light.",
    },
    {
      id: "colour",
      label: "Colour separation",
      pass: !enough ? null : avg.colour > 0.55,
      reading: enough ? `${pct(avg.colour)} of the way to clean colour` : "measuring…",
      remedy: "Colours are washing together. Try the Most reliable speed setting on the sender.",
    },
    {
      id: "decode",
      label: "Frames read",
      pass: !enough ? null : acceptRate > 0,
      reading: enough
        ? `${st.accepted} of ${st.pushed} frames decoded (${pct(acceptRate)})`
        : "measuring…",
      remedy:
        "Nothing is decoding yet. Fix whatever is failing above first — focus and framing account for almost all of it.",
    },
  ];

  if (!enough) {
    return {
      framesSeen: st.frames,
      checks,
      verdict: "measuring",
      summary: "Hold the camera on the test pattern.",
      recommend: null,
    };
  }

  const failed = checks.filter((c) => c.pass === false);
  const verdict: DoctorReport["verdict"] =
    acceptRate > 0.5 ? "good" : acceptRate > 0 ? "workable" : failed.length ? "bad" : "workable";

  // Recommended by measurement, not by guess: a link that decodes well can
  // afford density; one that barely decodes wants the most forgiving rung.
  const usable = profiles.length ? profiles : ["auto"];
  const recommend =
    acceptRate > 0.5
      ? usable[usable.length - 1]
      : acceptRate > 0
        ? usable[Math.floor(usable.length / 2)]
        : usable[0];

  const summary =
    verdict === "good"
      ? "This setup works. Start the sender."
      : verdict === "workable"
        ? "Marginal but decoding. It will be slow — fix what is failing to speed it up."
        : `Not working yet: ${failed.map((c) => c.label.toLowerCase()).join(", ")}.`;

  return { framesSeen: st.frames, checks, verdict, summary, recommend };
}
