/**
 * THE SWITCH between the test double and the real wasm bundle.
 *
 * Change the ONE line below and nothing else:
 *
 *     import mod from "./wasm-mock";   // <- the default
 *     import mod from "./wasm-real";   // <- the S7 bundle in app/src/wasm/
 *
 * The mock is the default deliberately, not because the real bundle is
 * missing. `app/src/wasm/.gitignore` is `*` — the bundle is a build artifact,
 * so a clean checkout does not have it and a static import of it would break
 * `npm run build` for anyone who has not built the wasm first. The mock always
 * builds, always runs, and is the app's permanent test double.
 *
 * `wasm-real.ts` is written, typechecked, and verified end to end through this
 * app against the real bundle. Flip the line once the wasm build is part of
 * your pipeline.
 *
 * Nothing else in the app imports either implementation directly.
 * `mod.implementation` tells the UI which one is live, and the UI says so on
 * screen rather than pretending.
 */
import mod from "./wasm-mock";
import type { OpticalModule } from "./wasm-api";

const optical: OpticalModule = mod;

export default optical;
export * from "./wasm-api";
