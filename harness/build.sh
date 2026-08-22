#!/usr/bin/env sh
# Build the size-optimised wasm bundle into app/src/wasm.
#
# The release profile settings ADR-0007 asks for (opt-level="z", fat LTO,
# panic="abort") cannot live in crates/wasm/Cargo.toml — Cargo ignores [profile] in a
# workspace member — and putting them in the workspace root would change the release
# profile of crates/core, whose spike binaries carry the measured S0-S5 numbers. So
# they are passed as environment overrides here, which apply only to this build.
set -e
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/tq-s7}"
export CARGO_PROFILE_RELEASE_OPT_LEVEL=z
export CARGO_PROFILE_RELEASE_LTO=fat
export CARGO_PROFILE_RELEASE_PANIC=abort
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
cd crates/wasm
wasm-pack build --release --target web --out-dir ../../app/src/wasm
cd ../..
raw=$(wc -c < app/src/wasm/optical_wasm_bg.wasm)
gz=$(gzip -9 -c app/src/wasm/optical_wasm_bg.wasm | wc -c)
echo "wasm: ${raw} B raw, ${gz} B gzipped"
