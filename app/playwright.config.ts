import { defineConfig, devices } from "@playwright/test";

/**
 * The suite runs against the PRODUCTION BUILD served by `vite preview`, not the
 * dev server, so what is tested is the bundle that ships — including the real
 * wasm core (`src/optical.ts` imports `wasm-real`). Testing only the mock would
 * miss exactly the class of bug that has actually bitten here.
 *
 *   npm run build && npm run test:e2e
 *
 * Chromium only: OPFS sync access handles, `createImageBitmap` into a worker
 * and `getDisplayMedia` are all exercised, and Chromium is the one engine where
 * the whole set is available headless.
 */
const MEDIA_ARGS = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--auto-accept-this-tab-capture",
];

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  webServer: {
    command: "npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: {
    baseURL: "http://localhost:4173",
    trace: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      testMatch: /app\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["camera"],
        launchOptions: {
          // A deterministic synthetic camera, so "camera" paths are reachable
          // without hardware. It shows Chromium's rolling test pattern, which
          // is NOT a valid code — useful for the fail-loud test, not for a
          // successful decode.
          args: MEDIA_ARGS,
        },
      },
    },
    // Phone-sized viewports. The reported bug was mobile-only: the send view's
    // status sat below the fold in fullscreen, and on iOS there is no
    // Fullscreen API for a non-video element at all.
    {
      name: "iphone",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        launchOptions: { args: MEDIA_ARGS },
      },
    },
    {
      name: "android",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 360, height: 800 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        launchOptions: { args: MEDIA_ARGS },
      },
    },
    // A phone on its side: no room for horizontal strips, so the layout has to
    // move the status into the pillarbox at the sides instead.
    {
      name: "iphone-landscape",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 844, height: 390 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        launchOptions: { args: MEDIA_ARGS },
      },
    },
  ],
});
