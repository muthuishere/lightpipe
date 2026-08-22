import { expect, test } from "@playwright/test";
import {
  canvasInk,
  openApp,
  qualitySelect,
  receiveVia,
  sendFile,
  sendText,
  shapeSelect,
  sourceSelect,
  startSending,
  stat,
  waitForOutcome,
} from "./helpers";

test.describe("transfer-qr", () => {
  test("loads on the real wasm core with no console errors", async ({ page }) => {
    const errors = await openApp(page);
    await expect(page.locator(".impl-badge")).toHaveText(/wasm core/i);
    await expect(page.locator(".impl-badge")).not.toHaveText(/mock/i);
    await expect(page.locator("h1")).toHaveText("transfer-qr");
    expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("markdown note survives a round trip and renders, with the codes matching", async ({
    page,
  }) => {
    await openApp(page);
    const note = "# Air gap\n\nA **note** with `inline code`.\n\n```rust\nfn main() {}\n```\n";
    await sendText(page, note);

    const sentCode = (await page.locator(".code.big").first().innerText()).trim();
    expect(sentCode).toMatch(/^[0-9A-Z]{6}$/);

    await startSending(page);
    await receiveVia(page, "screen");
    expect(await waitForOutcome(page)).toBe("complete");

    // The receiver's code must match the sender's — that comparison IS the
    // integrity check, since nothing is sent back the other way.
    const done = await page.locator(".notice.ok strong").last().innerText();
    expect(done).toContain(`COMPLETE ✓ ${sentCode}`);

    await expect(page.locator(".rendered h1")).toHaveText("Air gap");
    await expect(page.locator(".rendered pre code")).toContainText("fn main()");
    await expect(page.getByRole("button", { name: "Copy text" })).toBeVisible();
  });

  test("a small payload does not render as a thin strip on black", async ({ page }) => {
    await openApp(page);
    await sendText(page, "x".repeat(200));
    await startSending(page);
    await page.waitForTimeout(1500);

    const ink = await canvasInk(page);
    expect(ink).not.toBeNull();
    // Regression guard for the reported bug. Before the frame-fit pass a 200 B
    // note lit about 2 rows of a 1080-row frame (~0.2%). The app now picks a
    // frame the data occupies a real share of.
    //
    // The CEILING here is the engine, not the app: it draws the grid as a band
    // and leaves the rest of the frame black whatever size it is given, even at
    // 100% of its own reported capacity. These thresholds assert what the app
    // controls and will fail loudly if the fit regresses. Raise them when the
    // engine fills its frames.
    expect(ink!.litRowFraction).toBeGreaterThan(0.1);
    expect(ink!.colouredFraction).toBeGreaterThan(0.03);
  });

  test("portrait and landscape both render the right shape and both decode", async ({ page }) => {
    for (const [shape, wide] of [
      ["landscape", true],
      ["portrait", false],
    ] as const) {
      await openApp(page);
      await page.getByRole("tab", { name: "Loopback demo" }).click();
      await page.getByRole("button", { name: "Text / note" }).click();
      await page.locator("textarea").fill("shape check ".repeat(20));
      await shapeSelect(page).selectOption(shape);
      await page.getByRole("button", { name: "Use this note" }).click();
      await startSending(page);
      await page.waitForTimeout(800);

      const ink = await canvasInk(page);
      expect(ink, shape).not.toBeNull();
      if (wide) expect(ink!.width, shape).toBeGreaterThan(ink!.height);
      else expect(ink!.height, shape).toBeGreaterThan(ink!.width);

      await receiveVia(page, "screen");
      expect(await waitForOutcome(page), shape).toBe("complete");
    }
  });

  test("every offered quality setting completes, and no jargon reaches the user", async ({
    page,
  }) => {
    await openApp(page);
    await sendText(page, "quality ladder check ".repeat(10));

    // The engine is probed once at startup; wait for that before believing
    // which settings are on offer.
    await expect(qualitySelect(page)).toHaveAttribute("data-probed", "true");

    const options = qualitySelect(page).locator("option");
    const labels = await options.allInnerTexts();
    expect(labels.join(" | ")).toContain("Auto — pick for me");
    expect(labels.join(" | ")).toContain("Most reliable (slowest)");
    // Labels must never lead with our internal names.
    for (const l of labels) {
      expect(l).not.toMatch(/\bL[0-4]\b|\bP[248]\b|\bcells?\b|rung|fountain|fiducial/i);
    }

    // Settings the engine cannot actually round-trip are offered as disabled
    // rather than silently sending a picture nothing can read. Only exercise
    // the ones the app says are real.
    const enabled = await options.evaluateAll((os) =>
      (os as HTMLOptionElement[]).filter((o) => !o.disabled).map((o) => o.value),
    );
    expect(enabled.length).toBeGreaterThan(0);
    // If the engine ever grows the missing rungs back, this test picks them up
    // automatically instead of needing an edit.
    expect(enabled).toContain("auto");

    for (const quality of enabled) {
      await openApp(page);
      await page.getByRole("tab", { name: "Loopback demo" }).click();
      await expect(qualitySelect(page)).toHaveAttribute("data-probed", "true");
      await page.getByRole("button", { name: "Text / note" }).click();
      await page.locator("textarea").fill("quality ladder check ".repeat(10));
      await qualitySelect(page).selectOption(quality);
      await page.getByRole("button", { name: "Use this note" }).click();
      await startSending(page);
      await receiveVia(page, "screen");
      expect(await waitForOutcome(page), quality).toBe("complete");
    }
  });

  test("visible copy stays in plain language", async ({ page }) => {
    await openApp(page);
    await sendText(page, "plain language check");
    const text = await page.locator(".app").innerText();
    // The subtle profile caption is allowed; prose is not.
    const prose = text.replace(/\bL[0-4]\b/g, "");
    expect(prose).not.toMatch(/\bP[248]\b|potato|rung|fiducial|erasure|homography|fountain/i);
    expect(prose).not.toMatch(/ADR-\d{4}/);
  });

  test("screen capture is offered and decodes with the alignment search skipped", async ({
    page,
  }) => {
    await openApp(page);
    await sendText(page, "screen source check ".repeat(15));
    await startSending(page);

    const options = await sourceSelect(page).locator("option").allInnerTexts();
    expect(options.join(" | ")).toMatch(/Screen or window/);

    await receiveVia(page, "screen");
    expect(await waitForOutcome(page)).toBe("complete");
    // "Nothing to line up" only appears when the decoder really was told to
    // skip the geometry stage.
    await expect(page.locator(".app")).toContainText("Nothing to line up");
  });

  test("a windowed screen grab falls back to the alignment search instead of failing", async ({
    page,
  }) => {
    await openApp(page);
    // Big enough that the frame stays full size, which is the realistic case
    // for a windowed share.
    await sendFile(page, "demo.bin", "application/octet-stream", Buffer.alloc(40 * 1024, 3));
    await startSending(page);
    await receiveVia(page, "screen-window");
    expect(await waitForOutcome(page)).toBe("complete");
    await expect(page.locator(".app")).toContainText("Turned the alignment search back on");
  });

  test("an unreadable source fails loudly and fast, never hangs at 0%", async ({ page }) => {
    await openApp(page);
    await sendFile(page, "demo.bin", "application/octet-stream", Buffer.alloc(120 * 1024, 7));
    await startSending(page);
    const started = Date.now();
    await receiveVia(page, "hopeless");
    const outcome = await waitForOutcome(page, 30_000);
    expect(["no-signal", "failed"]).toContain(outcome);
    expect(Date.now() - started).toBeLessThan(25_000);
  });

  test("the send view never shows a fake progress state", async ({ page }) => {
    await openApp(page);
    await sendText(page, "status check");
    await startSending(page);
    await page.waitForTimeout(1500);
    const text = await page.locator(".app").innerText();
    expect(text).toMatch(/watch the receiving device/i);
    expect(text).not.toContain("measuring…");
    // A tiny payload must report a real pass length, not an unknown.
    expect(await stat(page, "ONE FULL PASS")).toMatch(/\d+ pictures/);
  });

  test("a real camera stream reaches the decoder", async ({ page }) => {
    await openApp(page);
    await page.getByRole("tab", { name: "Receive" }).click();
    await sourceSelect(page).selectOption("camera");
    await page.getByRole("button", { name: "Start receiving" }).click();
    // Chromium's fake device shows a rolling test pattern, which is not a code.
    // What is under test is that getUserMedia -> video -> worker is wired and
    // that the failure is reported rather than hung.
    const outcome = await waitForOutcome(page, 30_000);
    expect(["no-signal", "failed"]).toContain(outcome);
    await expect(page.locator(".app")).toContainText(/Camera settings|too low-resolution/);
  });
});
