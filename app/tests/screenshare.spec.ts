import { expect, test } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openApp, sourceSelect, simSelect, startSending } from "./helpers";

/**
 * THE SCREEN-CAPTURE PATH, MEASURED.
 *
 * Desktop-to-desktop screen share is the product's fastest and most reliable
 * path, and until now the 2.65 MB/s figure for it came from app instrumentation
 * with nothing in `artifacts/` behind it. This test produces that number
 * reproducibly and writes it out, so it becomes a citable measurement like
 * every other number in the project.
 *
 * WHAT THIS DOES AND DOES NOT COVER — read before trusting it.
 *
 * A real two-page test (page A sends, page B captures A's tab through
 * `getDisplayMedia`) could NOT be made to run here. Every flag combination
 * fails on this machine with `NotReadableError: Could not start video source`,
 * headless and headed alike, because macOS gates screen capture behind a
 * Screen-Recording TCC grant that the Chrome-for-Testing binary does not have
 * and that cannot be granted non-interactively. Combinations tried:
 *   --headless=new + --auto-select-desktop-capture-source=<title>
 *   --auto-accept-this-tab-capture + preferCurrentTab
 *   --auto-select-desktop-capture-source="Entire screen", headed and headless
 * See the report for detail. The blocker is the platform, not the flags.
 *
 * So the capture step here is the pixel-exact in-page path. That is NOT a
 * screen share — but everything downstream of the pixels is identical to one:
 * the same worker, the same real wasm decoder, the same geometry-skip
 * behaviour, the same OPFS write and the same file read back. What is missing
 * is the compositor and the video encoder between the two windows.
 */
test.describe("screen-capture path", () => {
  test("measures the pixel-exact path end to end and records the number", async ({ page }) => {
    const cases: Array<{ label: string; bytes: number; incompressible: boolean }> = [
      { label: "markdown 4 KB", bytes: 4 * 1024, incompressible: false },
      { label: "incompressible 256 KB", bytes: 256 * 1024, incompressible: true },
      { label: "incompressible 700 KB", bytes: 700 * 1024, incompressible: true },
    ];

    const lines: string[] = [];
    for (const c of cases) {
      const errors = await openApp(page);
      // Genuinely random, not a pattern: ADR-0014 gzips every chunk, so a
      // patterned "incompressible" buffer flatters the throughput enormously.
      const buf = c.incompressible
        ? crypto.randomBytes(c.bytes)
        : Buffer.from("# note\n\nthe quick brown fox jumps over the lazy dog. ".repeat(90));

      await page.getByRole("tab", { name: "Loopback demo" }).click();
      await page.locator('input[type="file"]').setInputFiles({
        name: "payload.bin",
        mimeType: "application/octet-stream",
        buffer: buf,
      });
      await page.getByRole("button", { name: "Start sending" }).waitFor();

      const sentCode = (await page.locator(".code.big").first().innerText()).trim();
      expect(sentCode).toMatch(/^[0-9A-Z]{6}$/);

      await startSending(page);
      await sourceSelect(page).selectOption("loopback");
      await simSelect(page).selectOption("screen");

      const t0 = Date.now();
      await page.getByRole("button", { name: "Start receiving" }).click();
      await expect(page.locator("button", { hasText: /^Save / })).toBeVisible({ timeout: 90_000 });
      const wall = (Date.now() - t0) / 1000;

      // The codes matching IS the integrity check — there is no back-channel.
      const done = await page.locator(".notice.ok strong").last().innerText();
      expect(done, "display codes must match").toContain(`COMPLETE ✓ ${sentCode}`);

      // The completion line is the authoritative summary: it is written from
      // the worker's own counters, not from anything the test computed.
      const text = await page.locator(".app").innerText();
      const summary = (text.match(/Received [^\n]+/) || [])[0] ?? "";
      const frames = parseInt(
        ((summary.match(/across ([\d,]+) frames/) || [])[1] ?? "0").replace(/,/g, ""),
        10,
      );
      const rate = (summary.match(/—\s*([\d.]+ [KMG]?B\/s)/) || [])[1] ?? "?";
      const unreadable = (summary.match(/of which ([\d,]+)/) || [])[1] ?? "?";
      expect(frames, "frame count must be readable from the summary").toBeGreaterThan(0);

      expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);

      const line =
        `${c.label.padEnd(22)} payload=${String(buf.length).padStart(7)} B  ` +
        `frames=${String(frames).padStart(5)}  unreadable=${String(unreadable).padStart(4)}  ` +
        `wall=${wall.toFixed(1)}s  rate=${rate}  code=${sentCode}`;
      lines.push(line);
      console.log(`  ${line}`);
    }

    // Write the artifact so the number is citable, with its caveat attached.
    const out = [
      "lightpipe — screen-capture path, measured end to end",
      `generated by tests/screenshare.spec.ts on ${new Date().toISOString()}`,
      "",
      "Sender canvas -> pixel-exact capture -> decode worker (real wasm core,",
      "alignment search skipped) -> OPFS -> file read back and verified by the",
      "6-character display code matching on both sides.",
      "",
      ...lines,
      "",
      "CAVEAT: the capture step is the in-page pixel-exact path, NOT a real",
      "getDisplayMedia screen share. getDisplayMedia could not be exercised in",
      "this environment: every flag combination fails with NotReadableError,",
      "headless and headed, because macOS gates screen capture behind a",
      "Screen-Recording permission the test binary does not hold. Everything",
      "downstream of the pixels is identical to a real share; the compositor and",
      "video encoder between two windows are not covered.",
      "",
    ].join("\n");

    const dir = path.resolve(process.cwd(), "..", "artifacts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "e2e-screenshare.txt"), out);
  });
});
