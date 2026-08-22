# Prior art: what we took and what we left

Screen-to-camera data transfer is not a new idea. It has an academic literature
going back fifteen years, an ISO standard, a working high-throughput open-source
implementation, and a deployed use in hardware wallets. Reading it first saved a
lot of time, and every ADR in this project is downstream of something on this list.

## PixNet (SIGCOMM '10) — treat it as a real channel

[PixNet](https://www.researchgate.net/publication/220926447_PixNet_Interference-free_wireless_links_using_LCD-camera_pairs)
runs **OFDM over an LCD–camera pair**: encode data in the 2-D spatial frequency
domain, transmit the image, take the FFT at the receiver.

The contribution we took is conceptual and it is the most important item on this
page: **screen→camera is a communications channel, not a picture of some data.**
It has a frequency response, it has noise, it has degradations you can model, and
you should measure it rather than eyeball it. Everything about
[the channel simulator](06-channel-simulation-as-methodology.md) descends from
taking that framing seriously.

What we left is the OFDM itself. Frequency-domain modulation is elegant — it
handles defocus gracefully, because blur is a low-pass filter and you simply stop
using the high bins. But it needs an FFT per frame on the receiver, careful
synchronisation, and it makes per-cell erasure semantics awkward. Our channel has
a specific dominant impairment (4:2:0 chroma decimation plus resample aliasing)
that spatial-domain cell coding attacks more directly.

## COBRA (MobiSys '12) — blur-adaptive block sizing

COBRA streams colour barcodes between phones and, crucially, **adapts block size
to blur**. Its insight is that the binding constraint is not colour count but
spatial resolution after defocus.

S1 reproduced exactly that. The simulated potato camera reads P8 (eight colours,
3 bits) cleanly at 14 px while failing at 8 px. Cell size is the axis that
matters; bits per cell rides along for free once the cells are big enough. That
finding is what rewrote the drafted [rate ladder](09-layered-broadcast.md).

What we left is COBRA's runtime adaptation, because it implies feedback. Our
[layered broadcast](09-layered-broadcast.md) gets the same coverage without a
back-channel by interleaving all the block sizes at once.

## LightSync — frame synchronisation is worth more than you think

LightSync's result on screen-to-camera streaming: **handling the frame
synchronisation problem properly nearly doubles throughput.** Screen refresh and
camera shutter are unsynchronised free-running clocks, so captures land
mid-refresh and frames tear.

The naive response is to slow the sender down until tearing is rare, which throws
away most of your rate. LightSync's point is that the sync problem deserves real
engineering, not a safety margin.

Our answer is different in mechanism and identical in spirit: torn and dropped
frames are converted into [erasures](04-crc32-and-erasure-semantics.md) and
absorbed by the [fountain](01-fountain-codes-raptorq.md) at a measured cost of
≤ 1 packet. We do not synchronise; we make desynchronisation free. `sim.rs` models
the tear explicitly (`tear_at`, with rows above the seam coming from the previous
frame, applied in image space after warp because a tear is a read-out artifact) —
though note that the S1 numbers were measured **without** tearing enabled and are
therefore an upper bound.

## JAB Code — ISO/IEC 23634:2022 (Fraunhofer SIT)

A standardised colour barcode, LGPL, with genuinely good palette research behind
it. [ADR-0003](../adr/0003-rgb-cube-corner-palette.md) borrows that research
directly — the 8-colour cube-corner palette is JAB's territory and we are standing
on it.

We left the format. [ADR-0002](../adr/0002-custom-cell-grid-not-qr.md) is blunt
about why: JAB Code is a **static document symbology**, not a streaming channel
format. It is built to survive being printed, photocopied and photographed at an
angle. We have a self-illuminated screen at a fixed distance and a stream, and the
robustness features we would inherit are ones we would then be paying for on every
frame.

## HCCB — Microsoft's High Capacity Color Barcode

Colour triangles, four or eight colours, deployed commercially and now retired.
Its value here is as the cautionary case: HCCB's density depended on print and
scan quality that real deployments did not reliably supply. The lesson is that a
colour format's real-world capacity is set by its worst supported reader, which is
precisely why `Channel::potato()` is declared *binding* rather than aspirational.

## libcimbar — the practical bar to beat

[libcimbar](https://github.com/sz3/libcimbar) is a working C++/Emscripten
colour-icon-matrix barcode system hitting **850 kbit/s** screen-to-camera. It is
the number to measure against, and its architecture — a cell matrix, fountain
coding across frames, browser delivery — is close enough that ADR-0002 says
outright "we follow its architecture".

We do not vendor it. Two reasons: we need a different runtime (a pure Rust core
compiled to WASM, per [ADR-0007](../adr/0007-rust-core-wasm-browser-only.md)), and
we need a different degradation story — libcimbar does not do the layered
guaranteed-completion broadcast of
[ADR-0011](../adr/0011-layered-rate-ladder-bad-cameras.md).

## BC-UR and txqr — animated QR, actually deployed

BC-UR is animated-QR data transfer **shipping today** in air-gapped hardware
wallets. [txqr](https://github.com/divan/txqr) is the classic open reference
implementation. Between them they prove the use case is real and that people will
hold a phone up to a screen to move a signed transaction across an air gap.

They also establish the ceiling we are trying to break: animated QR tops out
around **10–12 KB/s**. QR spends most of its area on finder patterns, timing
patterns, format info and alignment blocks, all designed so a phone can read a
crumpled poster at an angle — none of which we need on a flat, self-illuminated
screen at a fixed distance. ADR-0002 claims roughly 3–4× the payload area of a QR
of the same size from dropping that overhead. (That ratio is an estimate in the
ADR and has not been measured directly.)

## qrcp — the thing we are explicitly not

[qrcp](https://github.com/claudiodangelis/qrcp) encodes a **URL** in a QR code and
moves the bytes over Wi-Fi. The QR is a pointer.
[ADR-0001](../adr/0001-optical-channel-not-network.md) names this as solved,
mature and MIT-licensed, with nothing to add.

It is on this list because it defines the boundary. If you want a file off your
laptop and onto your phone, use qrcp; it will always be faster. Our value is the
**air gap** — no network, no Bluetooth, no NFC, no cable, at any point. The moment
a network appears, the entire premise is gone.
