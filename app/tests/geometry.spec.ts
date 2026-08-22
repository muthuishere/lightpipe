import { expect, test } from "@playwright/test";
import {
  assertNoScrollbar,
  openApp,
  screenGeometry,
  sendFile,
  sendText,
  startSending,
} from "./helpers";

/**
 * THE NUMBER THAT DECIDES WHETHER A CAMERA CAN READ THE SCREEN.
 *
 * A desktop send was photographed showing a portrait frame letterboxed onto a
 * 1920x1080 display: the code occupied the middle 25%, both side thirds pure
 * black, the data drawn as eleven thin bands. Every cell landed on a couple of
 * sensor pixels once the phone framed the whole screen — which it must, to see
 * all four corner markers. 145 frames sent, zero read.
 *
 * The objective is cell pitch in PHYSICAL SCREEN PIXELS, not fill of the frame:
 *
 *     screenPitch = cellPx * (displayArea / frameSize)
 *
 * so the frame's aspect must match the display and the frame should be as small
 * in pixels as the payload allows, because a smaller frame is scaled up harder.
 */
test.describe("code geometry on the display", () => {
  const CASES = [
    { label: "~100 byte note", kind: "text" as const, size: 100 },
    { label: "~100 KB file", kind: "file" as const, size: 100 * 1024 },
  ];

  for (const c of CASES) {
    test(`${c.label}: big blocks, filling the screen, markers intact`, async ({
      page,
    }, testInfo) => {
      await openApp(page);
      if (c.kind === "text") await sendText(page, "x".repeat(c.size));
      else
        await sendFile(
          page,
          "payload.bin",
          "application/octet-stream",
          Buffer.alloc(c.size, 7),
        );
      await startSending(page);
      await page.getByRole("button", { name: "Full screen" }).click();
      await expect(page.locator(".stage.immersive")).toBeVisible();
      await page.waitForTimeout(900);

      const g = await screenGeometry(page);
      expect(g).not.toBeNull();

      // 1. Tens of screen pixels per block, not a few. This is the whole point.
      expect(
        g!.screenPitch,
        `cell pitch only ${g!.screenPitch.toFixed(1)} screen px`,
      ).toBeGreaterThan(12);

      // 2. The code fills the display rather than being letterboxed into a
      //    fraction of it. The remainder is the two status strips.
      expect(g!.screenCoverage).toBeGreaterThan(0.75);

      // 3. Frame aspect follows the display, so `contain` does not letterbox.
      const frameAspect = g!.frame.w / g!.frame.h;
      const boxAspect = g!.cssBox.w / g!.cssBox.h;
      expect(Math.abs(frameAspect - boxAspect) / boxAspect).toBeLessThan(0.12);

      // 4. All four corner markers present. Below a certain frame size the core
      //    silently omits them, which produces a frame no camera can rectify —
      //    and which decodes fine in loopback, where geometry is switched off.
      expect(g!.fiducials, `corner white fractions ${JSON.stringify(g!.corners)}`).toBe(true);

      // 5. A real share of the display carries data.
      expect(g!.colouredOfViewport).toBeGreaterThan(0.1);

      await assertNoScrollbar(page, "immersive send");

      const line =
        `${g!.viewport.w}x${g!.viewport.h} · frame ${g!.frame.w}x${g!.frame.h} · ` +
        `cell ${g!.cellPx}px -> ${g!.screenPitch.toFixed(1)} screen px · ` +
        `covers ${Math.round(g!.screenCoverage * 100)}% of display · ` +
        `data ${Math.round(g!.colouredOfViewport * 100)}% of viewport · ` +
        `markers ${g!.corners.map((v) => Math.round(v * 100) + "%").join("/")}`;
      testInfo.annotations.push({ type: "geometry", description: line });
      console.log(`  [${c.label}] ${line}`);
    });
  }

  test("a forced portrait frame is never letterboxed onto a landscape screen", async ({
    page,
  }) => {
    await openApp(page);
    await sendText(page, "x".repeat(200));
    await startSending(page);
    await page.getByRole("button", { name: "Full screen" }).click();
    await page.waitForTimeout(900);

    const g = await screenGeometry(page);
    // On a landscape viewport the planned frame must be landscape too.
    expect(g!.viewport.w).toBeGreaterThan(g!.viewport.h);
    expect(g!.frame.w, "portrait frame on a landscape display").toBeGreaterThan(g!.frame.h);
  });

  test("Reset returns to the setup screen from fullscreen", async ({ page }) => {
    await openApp(page);
    await sendText(page, "reset check");
    await startSending(page);
    await page.getByRole("button", { name: "Full screen" }).click();
    await expect(page.locator(".stage.immersive")).toBeVisible();

    await page.getByRole("button", { name: "Reset" }).click();

    await expect(page.locator(".stage.immersive")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Text / note" })).toBeVisible();
    await expect(page.locator("body")).not.toHaveClass(/immersive-open/);
    // And it is genuinely restartable without leaving the page.
    await page.getByRole("button", { name: "Text / note" }).click();
    await page.locator("textarea").fill("second go");
    await page.getByRole("button", { name: "Use this note" }).click();
    await expect(page.getByRole("button", { name: "Start sending" })).toBeVisible();
  });

  test("no scrollbar anywhere in the send flow", async ({ page }) => {
    await openApp(page);
    // The setup page may exceed a short viewport vertically — it is a form,
    // and that is fine. What must never happen is a HORIZONTAL scrollbar, and
    // no scrollbar at all once the code is on screen: that is where a stolen
    // few pixels of width would change the frame plan.
    await assertNoScrollbar(page, "landing", "horizontal");
    await sendText(page, "scrollbar check ".repeat(4));
    await startSending(page);
    await page.getByRole("button", { name: "Full screen" }).click();
    await page.waitForTimeout(400);
    await assertNoScrollbar(page, "immersive");

    // Even after trying to scroll.
    await page.mouse.wheel(0, 2000);
    await page.evaluate(() => window.scrollTo(0, 3000));
    await page.waitForTimeout(200);
    const m = await assertNoScrollbar(page, "immersive after scroll attempt");
    expect(m.y).toBe(0);
    expect(m.x).toBe(0);
  });
});
