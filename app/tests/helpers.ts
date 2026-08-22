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
