#!/usr/bin/env node
/**
 * Bake a base-"/" production build of ../app into ./public, so the published
 * tarball carries the whole app (JS, CSS, and the .wasm core) and the CLI can
 * serve it with the machine offline.
 *
 * The GitHub Pages build uses BASE_PATH=/lightpipe/; a locally served build
 * must be rooted at "/", so this is a separate build, not a copy of app/dist.
 *
 * Nothing under app/ is overwritten: vite writes straight into cli/public via
 * --outDir, and the wasm bundle is only rebuilt when it is missing (it is a
 * gitignored artifact that the app itself needs to exist anyway).
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(CLI, "..");
const APP = join(ROOT, "app");
const OUT = join(CLI, "public");

const run = (cmd, args, cwd, env = {}) => {
  console.log(`$ ${cmd} ${args.join(" ")}   (in ${cwd.replace(ROOT, ".")})`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.error) die(`${cmd} could not be run: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} exited ${r.status}`);
};
const die = (m) => {
  console.error(`\nbuild-app: ${m}\n`);
  process.exit(1);
};
const has = (bin) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;

if (process.env.LIGHTPIPE_SKIP_BUILD === "1") {
  console.log("build-app: LIGHTPIPE_SKIP_BUILD=1, reusing cli/public as-is");
  process.exit(existsSync(join(OUT, "index.html")) ? 0 : 1);
}
if (!existsSync(APP)) die(`no app/ next to the package (looked in ${APP}). This script only runs from a source checkout.`);

// 1. wasm core -> app/src/wasm (gitignored; only built when absent)
const wasmBundle = join(APP, "src", "wasm", "optical_wasm_bg.wasm");
if (!existsSync(wasmBundle) || process.env.LIGHTPIPE_FORCE_WASM === "1") {
  if (!has("wasm-pack")) die("wasm-pack is not on PATH and app/src/wasm is missing.\n  install: cargo install wasm-pack   (or: brew install wasm-pack)");
  run("wasm-pack", ["build", "--target", "web", "--out-dir", "../../app/src/wasm"], join(ROOT, "crates", "wasm"));
} else {
  console.log("build-app: reusing existing app/src/wasm (set LIGHTPIPE_FORCE_WASM=1 to rebuild)");
}
if (!existsSync(wasmBundle)) die("the wasm bundle was not produced");

// 2. app deps
if (!existsSync(join(APP, "node_modules", "vite"))) run("npm", ["ci", "--no-audit", "--no-fund"], APP);

// 3. typecheck + base-"/" production build, straight into cli/public
run("npx", ["tsc", "--noEmit"], APP);
rmSync(OUT, { recursive: true, force: true });
run("npx", ["vite", "build", "--outDir", OUT, "--emptyOutDir"], APP, { BASE_PATH: "/" });

// 4. the tarball is worthless without these
const index = join(OUT, "index.html");
if (!existsSync(index)) die("no index.html in cli/public");
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const files = walk(OUT);
const wasm = files.filter((f) => f.endsWith(".wasm"));
if (!wasm.length) die("no .wasm in the build output — the core would not load offline");
const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(`\nbuild-app: ${files.length} files, ${(bytes / 1024).toFixed(0)} KB in cli/public`);
for (const f of files) console.log(`  ${(statSync(f).size / 1024).toFixed(0).padStart(5)} KB  ${f.slice(OUT.length + 1)}`);
