# ADR-0001: The channel is light, not a network

Status: Accepted · 2026-08-22

## Context
"QR file transfer" means two unrelated things. Tools like `qrcp` encode a URL in a
QR code and move the bytes over Wi-Fi — the QR is a pointer. That problem is solved
and we should not rebuild it.

## Decision
The file itself travels as light: an animated cell grid on a screen, read by a camera.
No network, no Bluetooth, no NFC, no cable at any point.

## Consequences
- Our value is **air-gap**, not convenience. Target user: someone moving a key,
  a signed transaction, or a document out of an isolated machine where USB is banned
  and radio is banned.
- Throughput will always lose to Wi-Fi. We do not compete on speed with `qrcp`.
- Every design trade resolves toward "works without any shared medium".

## Alternatives rejected
- **QR-as-pointer (`qrcp`)** — solved, mature, MIT. Nothing to add.
- **WebRTC / local socket** — requires a network, defeats the entire premise.
