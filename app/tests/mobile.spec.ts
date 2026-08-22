import { expect, test } from "@playwright/test";
import { openApp, sendText, startSending } from "./helpers";

/**
 * The reported bug, from a phone: in fullscreen send mode the status was not
 * visible without scrolling.
 *
 * Two causes. The layout put status BELOW the code instead of in the letterbox
 * dead space, and iOS Safari has no `requestFullscreen` for a non-video element
 * at all, so the button did nothing there. Fullscreen is now a CSS mode and the
 * status lives beside the code.
 *
 * The hard constraint these tests protect: status must be visible without
 * scrolling AND must never overlap the canvas, because anything drawn on the
 * cell grid corrupts the optical channel.
 */

async function enterFullscreen(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Full screen" }).click();
  await expect(page.locator(".stage.immersive")).toBeVisible();
  await page.waitForTimeout(300);
}

async function metrics(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
    };
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      scrollH: document.documentElement.scrollHeight,
      scrollW: document.documentElement.scrollWidth,
      scrollY: window.scrollY,
      code: box(".strip-code"),
      stop: box(".stage.immersive .btn.stop"),
      exit: box(".stage.immersive .btn.ghost"),
      canvas: box(".stage.immersive canvas"),
      top: box(".strip-top"),
      bottom: box(".strip-bottom"),
    };
  });
}

test.describe("fullscreen send on a phone", () => {
  test("display code and STOP are both on screen, with nothing over the code", async ({
    page,
  }, testInfo) => {
    await openApp(page);
    await sendText(page, "mobile fullscreen check ".repeat(6));
    await startSending(page);
    await enterFullscreen(page);

    const m = await metrics(page);
    const within = (b: NonNullable<typeof m.code>) =>
      b.top >= -1 && b.bottom <= m.vh + 1 && b.left >= -1 && b.right <= m.vw + 1;

    expect(m.code, "display code strip must exist").not.toBeNull();
    expect(m.stop, "STOP must exist").not.toBeNull();

    // 1. Visible without scrolling.
    expect(within(m.code!), `code ${JSON.stringify(m.code)} vs ${m.vw}x${m.vh}`).toBe(true);
    expect(within(m.stop!), `stop ${JSON.stringify(m.stop)} vs ${m.vw}x${m.vh}`).toBe(true);
    expect(within(m.exit!)).toBe(true);

    // 2. The status never sits on the cell grid.
    const canvas = m.canvas!;
    const clear = (b: NonNullable<typeof m.code>) =>
      b.bottom <= canvas.top + 1 ||
      b.top >= canvas.bottom - 1 ||
      b.right <= canvas.left + 1 ||
      b.left >= canvas.right - 1;
    expect(clear(m.code!), "code overlaps the canvas").toBe(true);
    expect(clear(m.stop!), "STOP overlaps the canvas").toBe(true);

    // 3. The code is the largest thing in the strip — it is what the human
    //    compares against the receiving screen.
    expect(m.code!.h).toBeGreaterThan(18);

    testInfo.annotations.push({
      type: "layout",
      description:
        `${m.vw}x${m.vh} · code ${Math.round(m.code!.w)}x${Math.round(m.code!.h)} @${Math.round(m.code!.top)} · ` +
        `canvas ${Math.round(canvas.w)}x${Math.round(canvas.h)} @${Math.round(canvas.top)} · ` +
        `stop @${Math.round(m.stop!.top)}-${Math.round(m.stop!.bottom)}`,
    });
    console.log(`  [${testInfo.project.name}] ${testInfo.annotations.at(-1)!.description}`);
  });

  test("the page does not scroll in fullscreen", async ({ page }) => {
    await openApp(page);
    await sendText(page, "no scrolling here ".repeat(6));
    await startSending(page);
    await enterFullscreen(page);

    await page.mouse.wheel(0, 1200);
    await page.evaluate(() => window.scrollTo(0, 2000));
    await page.waitForTimeout(200);

    const m = await metrics(page);
    expect(m.scrollY, "the page scrolled").toBe(0);
    // The immersive container is exactly the viewport, so there is nothing to
    // scroll to in the first place.
    expect(m.scrollH).toBeLessThanOrEqual(m.vh + 1);
    expect(m.scrollW).toBeLessThanOrEqual(m.vw + 1);
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  });

  test("fullscreen works without the Fullscreen API (the iOS case)", async ({ page }) => {
    await openApp(page);
    // Delete the API outright: this is what an iPhone actually presents for a
    // non-video element. The CSS mode must not care.
    await page.evaluate(() => {
      // @ts-expect-error deliberately removing a platform API
      delete Element.prototype.requestFullscreen;
      // @ts-expect-error same
      delete Document.prototype.exitFullscreen;
    });
    await sendText(page, "ios has no fullscreen api ".repeat(4));
    await startSending(page);
    await enterFullscreen(page);

    const m = await metrics(page);
    expect(m.code).not.toBeNull();
    expect(m.code!.bottom).toBeLessThanOrEqual(m.vh + 1);
    expect(m.stop!.bottom).toBeLessThanOrEqual(m.vh + 1);
  });

  test("escape and the ✕ both leave fullscreen", async ({ page }) => {
    await openApp(page);
    await sendText(page, "exit check");
    await startSending(page);

    await enterFullscreen(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".stage.immersive")).toHaveCount(0);

    await enterFullscreen(page);
    await page.locator(".stage.immersive .btn.ghost").click();
    await expect(page.locator(".stage.immersive")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/immersive-open/);
  });

  test("the send view fits a phone before fullscreen too", async ({ page }) => {
    await openApp(page);
    await page.getByRole("tab", { name: "Send" }).click();
    await page.getByRole("button", { name: "Text / note" }).click();

    // Nothing may overflow sideways at any point in the flow.
    const noSideScroll = async (where: string) => {
      const m = await page.evaluate(() => ({
        w: document.documentElement.scrollWidth,
        vw: window.innerWidth,
      }));
      expect(m.w, `${where}: horizontal overflow`).toBeLessThanOrEqual(m.vw + 1);
    };

    await noSideScroll("empty send view");
    await page.locator("textarea").fill("phone layout check");
    await page.getByRole("button", { name: "Use this note" }).click();
    await page.getByRole("button", { name: "Start sending" }).waitFor();
    await noSideScroll("with a manifest");

    await startSending(page);
    await noSideScroll("while sending");

    // The code must be reachable, not buried under a stack of controls.
    const canvasBox = await page.locator(".stage canvas").boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(canvasBox!.width).toBeGreaterThan(0);
  });
});
