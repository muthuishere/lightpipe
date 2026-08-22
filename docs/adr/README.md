# Architecture Decision Records

One file per decision that closes an option. Format: Context / Decision /
Consequences / Alternatives rejected. Never edit an accepted ADR to change its
meaning — supersede it with a new one and mark the old `Superseded by ADR-NNNN`.

| # | decision | status |
|---|---|---|
| [0001](0001-optical-channel-not-network.md) | The channel is light, not a network | Accepted |
| [0002](0002-custom-cell-grid-not-qr.md) | Custom cell grid, not QR | Accepted |
| [0003](0003-rgb-cube-corner-palette.md) | RGB-cube-corner palette; P4 default | Accepted |
| [0004](0004-fountain-codes.md) | Fountain across frames, CRC-drop within | Accepted |
| [0005](0005-no-backchannel-human-integer.md) | No back-channel; human types one integer | Accepted |
| [0006](0006-chunked-gzip.md) | Chunk first, gzip per chunk, fountain per chunk | Accepted |
| [0007](0007-rust-core-wasm-browser-only.md) | Rust core → WASM; browser-only | Accepted |
| [0008](0008-opfs-not-file-system-access.md) | OPFS, not File System Access API | Accepted |
| [0009](0009-pure-core-and-channel-simulator.md) | Pure core + channel simulator | Accepted |
| [0010](0010-spike-first-delivery.md) | Spike-first delivery | Accepted |
| [0011](0011-layered-rate-ladder-bad-cameras.md) | Layered rate ladder; bad cameras must complete | Accepted · amended by 0012 |
| [0012](0012-one-symbol-size-across-the-ladder.md) | One fountain symbol size across the whole ladder | Accepted |
| [0013](0013-frame-header-seq-is-the-chunk-ordinal.md) | Frame header `seq` is the chunk ordinal | Accepted |
| [0014](0014-always-compress.md) | Always chunk and gzip; no raw mode, no probe (supersedes ADR-0006's probe) | Accepted |
| [0015](0015-cache-the-homography.md) | Decoder is stateful; cache the homography, warp only sample points | Accepted |
| [0016](0016-validation-handshake.md) | A validation handshake before the blind transfer (refines ADR-0005) | Accepted |
| [0017](0017-preflight-doctor-and-start-order.md) | Receiver starts first; a preflight doctor before any transfer | Accepted |
