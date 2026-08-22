import type { Page } from "@playwright/test";

/** Every case is a full round trip in one tab: sender canvas -> simulated capture
 *  -> decode worker -> OPFS -> saved file. No hardware involved. */

export async function openApp(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.goto("/", { waitUntil: "networkidle" });
  return errors;
}

export const senderSelect = (page: Page, optionValue: string) =>
  page.locator("select").filter({ has: page.locator(`option[value="${optionValue}"]`) });

/** The receive-source dropdown (it is the one holding the loopback option). */
export const sourceSelect = (page: Page) => senderSelect(page, "loopback");
/** The simulated-camera dropdown. */
export const simSelect = (page: Page) => senderSelect(page, "weak");
/** Quality / speed. */
export const qualitySelect = (page: Page) => senderSelect(page, "L0");
/** Frame shape. */
export const shapeSelect = (page: Page) => senderSelect(page, "portrait");

export async function sendText(page: Page, body: string) {
  await page.getByRole("tab", { name: "Loopback demo" }).click();
  await page.getByRole("button", { name: "Text / note" }).click();
  await page.locator("textarea").fill(body);
  await page.getByRole("button", { name: "Use this note" }).click();
  await page.getByRole("button", { name: "Start sending" }).waitFor();
}

export async function sendFile(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByRole("tab", { name: "Loopback demo" }).click();
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
  await page.getByRole("button", { name: "Start sending" }).waitFor();
}

export async function startSending(page: Page) {
  await page.getByRole("button", { name: "Start sending" }).click();
  await page.waitForTimeout(400);
}

export async function receiveVia(page: Page, preset: string) {
  await sourceSelect(page).selectOption("loopback");
  await simSelect(page).selectOption(preset);
  await page.getByRole("button", { name: "Start receiving" }).click();
}

/** Resolves when the transfer finishes, or when the app says it cannot. */
export async function waitForOutcome(page: Page, ms = 90_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await page.locator("button", { hasText: /^Save / }).count()) return "complete";
    const text = await page.locator(".app").innerText();
    if (text.includes("Nothing is decoding")) return "no-signal";
    // Capture mode says the same thing in four words instead of a paragraph.
    if (/Move closer — fill the frame|Hold steadier — less glare/.test(text)) return "no-signal";
    if (text.includes("Receive failed")) return "failed";
    await page.waitForTimeout(400);
  }
  return "timeout";
}

/** The 6-character code shown on the sending side. */
export async function senderCode(page: Page) {
  const text = await page.locator(".app").innerText();
  return (text.match(/COMPLETE ✓ ([0-9A-Z]{6})/) || text.match(/\n([0-9A-Z]{6})\n/) || [])[1];
}

export async function stat(page: Page, label: string) {
  const text = await page.locator(".app").innerText();
  return (text.match(new RegExp(label + "\\n([^\\n]+)")) || [])[1];
}

/** Colour coverage of the sender's canvas: what fraction carries data. */
export async function canvasInk(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector(".stage canvas") as HTMLCanvasElement | null;
    if (!c) return null;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let coloured = 0;
    let total = 0;
    let litRows = 0;
    for (let y = 0; y < c.height; y += 2) {
      let rowHasInk = false;
      for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        total++;
        const dark = r < 40 && g < 40 && b < 40;
        const pale = r > 215 && g > 215 && b > 215;
        if (!dark && !pale) {
          coloured++;
          rowHasInk = true;
        }
      }
      if (rowHasInk) litRows++;
    }
    return {
      width: c.width,
      height: c.height,
      colouredFraction: coloured / Math.max(1, total),
      litRowFraction: litRows / Math.max(1, Math.ceil(c.height / 2)),
    };
  });
}

/**
 * A scrollbar is not just ugly here: it steals viewport width, which changes
 * the frame-size calculation, which shrinks the code or starts a resize loop.
 * Nothing in the send or capture views may ever produce one.
 */
export async function assertNoScrollbar(
  page: Page,
  where: string,
  axis: "both" | "horizontal" = "both",
) {
  const m = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return {
      sw: el.scrollWidth,
      sh: el.scrollHeight,
      vw: window.innerWidth,
      vh: window.innerHeight,
      y: window.scrollY,
      x: window.scrollX,
    };
  });
  const bad = axis === "both" ? m.sw > m.vw + 1 || m.sh > m.vh + 1 : m.sw > m.vw + 1;
  if (bad) {
    throw new Error(
      `${where}: scrollable — content ${m.sw}x${m.sh} vs viewport ${m.vw}x${m.vh}`,
    );
  }
  return m;
}

/** Geometry of the code as it lands on the physical display. */
export async function screenGeometry(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector(".stage canvas") as HTMLCanvasElement | null;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const ctx = c.getContext("2d")!;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;

    let coloured = 0;
    let total = 0;
    for (let y = 0; y < c.height; y += 2) {
      for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4;
        const R = d[i];
        const G = d[i + 1];
        const B = d[i + 2];
        total++;
        const dark = R < 40 && G < 40 && B < 40;
        const pale = R > 215 && G > 215 && B > 215;
        if (!dark && !pale) coloured++;
      }
    }

    // Cell pitch in canvas pixels: median run of unchanging colour along rows.
    const runs: number[] = [];
    for (let k = 1; k <= 24; k++) {
      const y = Math.floor((c.height * k) / 25);
      const base = (y * c.width) * 4;
      let run = 1;
      for (let x = 1; x < c.width; x++) {
        const a = base + x * 4;
        const b = base + (x - 1) * 4;
        if (d[a] === d[b] && d[a + 1] === d[b + 1] && d[a + 2] === d[b + 2]) run++;
        else {
          if (run > 1 && run < c.width / 4) runs.push(run);
          run = 1;
        }
      }
    }
    runs.sort((p, q) => p - q);
    const cellPx = runs.length ? runs[Math.floor(runs.length / 2)] : 0;

    // How the canvas is actually scaled onto the display.
    const scale = Math.min(r.width / c.width, r.height / c.height);
    const shownW = c.width * scale;
    const shownH = c.height * scale;

    // Are the four corner markers present? A frame without them can never be
    // rectified by a camera, whatever its cell size looks like.
    const box = Math.min(120, Math.floor(Math.min(c.width, c.height) / 4));
    const cornerWhite = (x0: number, y0: number) => {
      let white = 0;
      let n = 0;
      for (let y = y0; y < y0 + box && y < c.height; y++) {
        for (let x = x0; x < x0 + box && x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          n++;
          if (d[i] > 215 && d[i + 1] > 215 && d[i + 2] > 215) white++;
        }
      }
      return n ? white / n : 0;
    };
    const corners = [
      cornerWhite(0, 0),
      cornerWhite(c.width - box, 0),
      cornerWhite(0, c.height - box),
      cornerWhite(c.width - box, c.height - box),
    ];

    return {
      frame: { w: c.width, h: c.height },
      cssBox: { w: Math.round(r.width), h: Math.round(r.height) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      cellPx,
      screenPitch: cellPx * scale,
      shown: { w: Math.round(shownW), h: Math.round(shownH) },
      screenCoverage: (shownW * shownH) / (window.innerWidth * window.innerHeight),
      colouredOfFrame: coloured / Math.max(1, total),
      colouredOfViewport:
        (coloured / Math.max(1, total)) *
        ((shownW * shownH) / (window.innerWidth * window.innerHeight)),
      corners,
      fiducials: corners.every((c2) => c2 > 0.15),
    };
  });
}
