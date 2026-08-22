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

/**
 * The second report, also from a real phone: the RECEIVE view needed scrolling
 * while capturing. "need more" — the only number that matters — was below the
 * fold, under a camera diagnostic card, a storage line, a five-line error
 * paragraph, an explanation, a quality bar and an eight-cell stats grid.
 *
 * A person aiming a phone at another screen has both hands occupied. Scrolling
 * is not available to them, so nothing they need may require it — and nothing
 * they need may be behind a tap either: when a scan is not working, WHY has to
 * be on screen already. The answer is density, not disclosure.
 *
 * These run against Chromium's fake camera: it emits a rolling test pattern
 * that is not a valid code, which is exactly the state the user was stuck in
 * and the hardest one to lay out well.
 */
test.describe("receive capture mode on a phone", () => {
  /** Every LIVE value that must be readable without scrolling or tapping. */
  const LIVE_STATS = [
    "need",
    "problem",
    "quality",
    "received",
    "speed",
    "pieces",
    "left",
    "rate",
    "seen",
    "unreadable",
    "repeats",
  ];

  async function startCapture(page: import("@playwright/test").Page) {
    await openApp(page);
    await page.getByRole("tab", { name: "Receive" }).click();
    await page
      .locator("select")
      .filter({ has: page.locator('option[value="loopback"]') })
      .selectOption("camera");
    await page.getByRole("button", { name: "Start receiving" }).click();
    await expect(page.locator(".capture")).toBeVisible();
    await page.waitForTimeout(1200);
  }

  async function hud(page: import("@playwright/test").Page) {
    return page.evaluate((stats: string[]) => {
      const box = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          w: r.width,
          h: r.height,
        };
      };
      const values: Record<string, { box: ReturnType<typeof box>; text: string } | null> = {};
      for (const name of stats) {
        const el = document.querySelector(`[data-stat="${name}"]`);
        values[name] = el
          ? { box: box(`[data-stat="${name}"]`), text: (el.textContent || "").trim() }
          : null;
      }
      const need = document.querySelector(".need-value");
      return {
        vw: window.innerWidth,
        vh: window.innerHeight,
        scrollY: window.scrollY,
        scrollH: document.documentElement.scrollHeight,
        values,
        needText: need ? (need.textContent || "").trim() : null,
        needLabel: (document.querySelector(".need-label")?.textContent || "").trim(),
        stop: box(".capture .btn.stop"),
        sheet: box(".capture .hud-sheet"),
        video: box(".capture-video"),
        needFontPx: need ? parseFloat(getComputedStyle(need).fontSize) : 0,
      };
    }, LIVE_STATS);
  }

  test("every live status value and stop are on screen at once, no scroll, no tap", async ({
    page,
  }, testInfo) => {
    await startCapture(page);
    const m = await hud(page);

    const within = (b: { top: number; bottom: number; left: number; right: number }) =>
      b.top >= -1 && b.bottom <= m.vh + 1 && b.left >= -1 && b.right <= m.vw + 1;

    // Nothing is behind a disclosure.
    expect(m.sheet, "the setup sheet must start collapsed").toBeNull();

    const missing: string[] = [];
    const offscreen: string[] = [];
    for (const name of LIVE_STATS) {
      const v = m.values[name];
      if (!v || !v.box) {
        missing.push(name);
        continue;
      }
      if (!within(v.box)) offscreen.push(`${name} @${Math.round(v.box.top)}-${Math.round(v.box.bottom)}`);
    }
    expect(missing, "live values not rendered at all").toEqual([]);
    expect(offscreen, `live values outside the ${m.vw}x${m.vh} viewport`).toEqual([]);
    expect(within(m.stop!), `stop ${JSON.stringify(m.stop)}`).toBe(true);

    // "need more" is still the largest thing on screen.
    expect(m.needFontPx).toBeGreaterThan(30);

    // And the page genuinely cannot move.
    await page.mouse.wheel(0, 1400);
    await page.evaluate(() => window.scrollTo(0, 2500));
    await page.waitForTimeout(200);
    const after = await hud(page);
    expect(after.scrollY, "the page scrolled").toBe(0);
    expect(after.scrollH).toBeLessThanOrEqual(after.vh + 1);

    const rows = LIVE_STATS.map(
      (n) => `${n} @${Math.round(m.values[n]!.box!.top)}`,
    ).join(" · ");
    testInfo.annotations.push({
      type: "layout",
      description:
        `${m.vw}x${m.vh} · need "${m.needText}" ${Math.round(m.needFontPx)}px · ` +
        `video ${Math.round(m.video!.w)}x${Math.round(m.video!.h)} · ` +
        `stop @${Math.round(m.stop!.top)}-${Math.round(m.stop!.bottom)} · ${rows}`,
    });
    console.log(`  [${testInfo.project.name}] ${testInfo.annotations.at(-1)!.description}`);
  });

  test("need-more says nothing rather than a misleading number before a code arrives", async ({
    page,
  }) => {
    await startCapture(page);
    const m = await hud(page);
    // The core answers 1 before any header has decoded, which reads as "almost
    // done" while in fact nothing has been seen. The UI must not repeat that.
    expect(m.needText).toBe("—");
    expect(m.needLabel).toBe("looking for a code");
  });

  test("only static setup is behind the disclosure", async ({ page }) => {
    await startCapture(page);
    await page.getByRole("button", { name: "Setup" }).click();
    const sheet = page.locator(".capture .hud-sheet");
    await expect(sheet).toBeVisible();
    // Setup information, not live status.
    await expect(sheet).toContainText(/Camera settings|Storage/);

    const m = await hud(page);
    expect(m.sheet!.bottom).toBeLessThanOrEqual(m.vh + 1);
    expect(m.scrollY).toBe(0);

    await page.getByRole("button", { name: "Hide setup" }).click();
    await expect(sheet).toHaveCount(0);
  });

  test("trouble is one short line, and the numbers stay put", async ({ page }) => {
    await startCapture(page);
    // The fake camera never decodes, so the loud-failure path fires.
    await page.waitForTimeout(8000);
    const line = (await page.locator('[data-stat="problem"]').innerText()).trim();
    expect(line.length).toBeLessThan(40);
    expect(line).toMatch(/Move closer|Hold steadier|Sharp|Too soft/);

    const m = await hud(page);
    for (const name of LIVE_STATS) {
      const b = m.values[name]!.box!;
      expect(b.bottom, `${name} fell off the bottom`).toBeLessThanOrEqual(m.vh + 1);
    }
    expect(m.stop!.bottom).toBeLessThanOrEqual(m.vh + 1);
  });
});

/**
 * ADR-0017: the preflight doctor. The first real-camera test produced 385
 * frames seen, 385 unreadable and nothing decoded, with correctly framed
 * markers — and the only feedback was "Nothing is decoding" plus a paragraph of
 * guesses. This is the surface that replaces guessing with named measurements.
 */
test.describe("preflight doctor", () => {
  test("names every check with a reading, and stays on one screen", async ({ page }) => {
    await openApp(page);
    await page.getByRole("tab", { name: "Receive" }).click();
    await page.getByRole("button", { name: "Check my setup" }).click();
    await expect(page.locator(".capture")).toBeVisible();
    await expect(page.locator("[data-doctor]")).toBeVisible({ timeout: 20_000 });

    // Every ADR-0017 check is present, and each carries a measured reading.
    for (const id of ["fiducials", "sharpness", "fill", "exposure", "colour", "decode"]) {
      const row = page.locator(`[data-check="${id}"]`);
      await expect(row, id).toBeVisible();
      await expect(row.locator("i"), `${id} reading`).not.toBeEmpty();
    }

    // A verdict, not a shrug.
    await expect(page.locator('[data-stat="verdict"]')).not.toBeEmpty();

    const m = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-check]")].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.getAttribute("data-check"),
          pass: el.getAttribute("data-pass"),
          bottom: r.bottom,
          reading: el.querySelector("i")?.textContent ?? "",
        };
      });
      const stop = document.querySelector(".capture .btn.stop")!.getBoundingClientRect();
      return { vh: window.innerHeight, rows, stopBottom: stop.bottom, y: window.scrollY };
    });

    for (const r of m.rows) {
      expect(r.bottom, `${r.id} fell off the bottom`).toBeLessThanOrEqual(m.vh + 1);
    }
    expect(m.stopBottom).toBeLessThanOrEqual(m.vh + 1);
    expect(m.y).toBe(0);
    console.log(
      `  [doctor] ${m.rows.map((r) => `${r.id}=${r.pass}(${r.reading})`).join(" · ")}`,
    );
  });

  test("a camera that cannot decode fails the checks rather than saying nothing", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByRole("tab", { name: "Receive" }).click();
    await page.getByRole("button", { name: "Check my setup" }).click();
    await expect(page.locator("[data-doctor]")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(4000);

    // Chromium's fake camera shows a rolling pattern, never a code, so the
    // decode check must fail — and it must say what to do about it.
    const decode = page.locator('[data-check="decode"]');
    await expect(decode).toHaveAttribute("data-pass", "false");
    await expect(decode.locator("em")).not.toBeEmpty();
  });
});
