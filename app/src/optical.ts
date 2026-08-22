/**
 * THE SWITCH between the test double and the real wasm bundle.
 *
 * Change the ONE line below and nothing else:
 *
 *     import mod from "./wasm-mock";   // <- the default
 *     import mod from "./wasm-real";   // <- the S7 bundle in app/src/wasm/
 *
 * The REAL bundle is the default. It is a build artifact — `app/src/wasm/` is
 * gitignored — so `task wasm:build` must run before `npm run build`. The Pages
 * workflow does exactly that, and `npm run build` fails loudly if it is missing
 * rather than silently shipping the test double.
 *
 * The mock remains the app's permanent test double: it is what `npm run smoke`
 * and `npm run selftest` drive, so the UI stays exercisable with no Rust
 * toolchain at all.
 *
 * Nothing else in the app imports either implementation directly.
 * `mod.implementation` tells the UI which one is live, and the UI says so on
 * screen rather than pretending.
 */
import mod from "./wasm-real";
import type { OpticalModule } from "./wasm-api";

const optical: OpticalModule = mod;

export default optical;
export * from "./wasm-api";
