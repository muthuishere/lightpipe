/**
 * Adapter for the REAL wasm bundle (S7 output, `app/src/wasm/`).
 *
 * The bundle is owned by the wasm agent and this app never writes to it. It is
 * also a build artifact (`app/src/wasm/.gitignore` is `*`), so a clean checkout
 * does not have it — which is exactly why `optical.ts` still defaults to the
 * mock and this file is opt-in. Flip the one import in `optical.ts` once the
 * bundle is part of your build.
 *
 * WHERE THE SHIPPED BUNDLE DIVERGES FROM docs/contracts/wasm-api.md
 * ----------------------------------------------------------------
 *  - `memory` is not a module export. It comes off the `InitOutput` returned by
 *    wasm-bindgen's default init, so the module has to be initialised before
 *    any ptr/len is meaningful. Handled here.
 *  - Fallible calls return `undefined`, not `null`. Same intent, different
 *    value; normalised here so the app only ever sees `null`.
 *  - `OpticalReceiver.resume` takes the manifest as BYTES from the sender's
 *    `manifestBytes()`, not as a `Manifest` object. The contract says object.
 *    The bundle's shape is the right one — only the serialised manifest carries
 *    the per-chunk BLAKE3 hashes resume needs — but it is a contract change.
 *  - Extra, not in the contract and used here where noted:
 *    `frameCapacity(profile, w, h)`, `manifestBytes()`, `verifyChunk()`,
 *    `stats()`, and the `bench*` hooks.
 *
 * NOTE ON THE IMPORT. This is a STATIC import, and it has to be.
 *
 * It was briefly a dynamic import with a non-literal specifier, so that the
 * repo would typecheck on a checkout with no wasm build. That worked in dev and
 * silently broke the production bundle: Vite cannot see through a non-literal
 * specifier, so it never emitted the glue at that path, and the DECODE WORKER —
 * a separate chunk — 404'd on it at runtime. The page still loaded, the badge
 * still said "wasm core", and nothing decoded. The e2e suite caught it; a human
 * would have called it "the app is broken".
 *
 * The cost of a static import is that `src/wasm/` must exist to build. That is
 * normal for a wasm project, and `tsconfig.json` excludes this file so a
 * checkout using the mock still typechecks without the bundle.
 */
import type {
  Manifest,
  OpticalModule,
  OpticalReceiver,
  OpticalSender,
  PushResult,
  SenderOptions,
  SenderProgress,
  TakenChunk,
} from "./wasm-api";

// Static import so Vite fingerprints the .wasm and rewrites its URL for the
// deployed base path. A dynamic non-literal specifier keeps the repo building
// without the bundle, but Vite then cannot see the asset and the deploy 404s.
// The bundle is a build artifact: run `task wasm:build` before `npm run build`.
import initWasm, {
  OpticalSender as WasmSender,
  OpticalReceiver as WasmReceiver,
  frameCapacity as wasmFrameCapacity,
} from "./wasm/optical_wasm.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyModule = {
  default: (...a: unknown[]) => Promise<{ memory: WebAssembly.Memory }>;
  OpticalSender: { create(bytes: Uint8Array, opts: unknown): unknown };
  OpticalReceiver: { create(opts: unknown): unknown };
  frameCapacity(profile: string, width: number, height: number): number;
};

let bundle: AnyModule | null = null;
let mem: WebAssembly.Memory | null = null;

function mod(): AnyModule {
  if (!bundle) throw new Error("optical wasm not initialised — call init() first");
  return bundle;
}

const memoryFacade = {
  get buffer(): ArrayBufferLike {
    if (!mem) throw new Error("optical wasm not initialised — call init() first");
    // Always re-read: wasm memory growth detaches the previous buffer.
    return mem.buffer;
  },
};

function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`optical wasm: ${what} failed`);
  return v;
}

const senderCtor = {
  create(bytes: Uint8Array, opts: SenderOptions = {}): OpticalSender {
    const s = need(mod().OpticalSender.create(bytes, opts), "OpticalSender.create") as WasmSenderLike;
    return {
      manifest: () => s.manifest() as unknown as Manifest,
      nextFrame: () => need(s.nextFrame(), "nextFrame") as unknown as ReturnType<
        OpticalSender["nextFrame"]
      >,
      progress: () => s.progress() as unknown as SenderProgress,
      setProfile: (p) => {
        s.setProfile(p);
      },
      free: () => s.free(),
    };
  },
};

const receiverCtor = {
  create(opts: { width?: number; height?: number } = {}): OpticalReceiver {
    return wrapReceiver(
      need(mod().OpticalReceiver.create(opts), "OpticalReceiver.create") as WasmReceiverLike,
    );
  },
  resume(code: string, manifest: Manifest, haveChunks: Uint8Array): OpticalReceiver | null {
    // The bundle wants the serialised manifest, which a Manifest object cannot
    // provide. Rather than fake it, refuse loudly — see the note at the top.
    void manifest;
    void code;
    void haveChunks;
    return null;
  },
};

interface WasmSenderLike {
  manifest(): unknown;
  nextFrame(): unknown;
  progress(): unknown;
  setProfile(p: string): boolean;
  free(): void;
}

interface WasmReceiverLike {
  frameBuffer(): unknown;
  pushFrame(): unknown;
  manifest(): unknown;
  neededMore(): number;
  resumeCode(): string;
  displayCode(): string | undefined;
  takeChunk(): unknown;
  isComplete(): boolean;
  free(): void;
  setGeometry(on: boolean): void;
}

function wrapReceiver(r: WasmReceiverLike): OpticalReceiver {
  return {
    frameBuffer: () => r.frameBuffer() as unknown as { ptr: number; len: number },
    pushFrame: () => r.pushFrame() as unknown as PushResult,
    manifest: () => (r.manifest() as unknown as Manifest) ?? null,
    neededMore: () => r.neededMore(),
    resumeCode: () => r.resumeCode(),
    displayCode: () => r.displayCode() ?? null,
    takeChunk: () => (r.takeChunk() as unknown as TakenChunk) ?? null,
    isComplete: () => r.isComplete(),
    free: () => r.free(),
    // Test hook in the bundle, load-bearing here — see wasm-api.ts.
    setGeometry: (on: boolean) => r.setGeometry(on),
  };
}

/** Not in the contract; the bundle exposes it, so expose it to callers that want it. */
export function payloadPerFrame(profile: string, width: number, height: number): number {
  return mod().frameCapacity(profile, width, height);
}

const realModule: OpticalModule = {
  init: async () => {
    bundle = {
      default: initWasm as AnyModule["default"],
      OpticalSender: WasmSender as unknown as AnyModule["OpticalSender"],
      OpticalReceiver: WasmReceiver as unknown as AnyModule["OpticalReceiver"],
      frameCapacity: wasmFrameCapacity as AnyModule["frameCapacity"],
    };
    const out = await initWasm();
    mem = (out as unknown as { memory: WebAssembly.Memory }).memory;
  },
  memory: memoryFacade,
  OpticalSender: senderCtor,
  OpticalReceiver: receiverCtor,
  implementation: "wasm",
  frameCapacity: (profile, width, height) => mod().frameCapacity(profile, width, height),
};

export default realModule;
