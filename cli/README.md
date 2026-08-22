# lightpipe

Move a file between two devices using **nothing but light** — one screen animates
a grid of coloured cells, the other device's camera reads them. No network, no
Bluetooth, no NFC, no pairing, no cable, at any point.

This package is the **offline launcher**: it serves the whole web app — React
bundle *and* the Rust/WebAssembly core — from files inside the package, so the
tool works on a machine with no internet at all. Zero telemetry, no update
check, no outbound socket, ever.

```bash
npx lightpipe send report.pdf       # serve, open a browser, START BROADCASTING
npx lightpipe send --text "hi"      # a literal string, sent as markdown
cat notes.md | npx lightpipe send   # stdin
npx lightpipe receive camera        # capture from the webcam (the default)
npx lightpipe receive screen        # capture a screen/window — 21x faster
npx lightpipe receive --out ./in    # write the finished file straight to disk
npx lightpipe serve                 # just serve; choose a mode in the browser
npx lightpipe --host 0.0.0.0        # expose on the LAN; prints the LAN URL + a QR
```

## What is automatic and what is not

* **automatic** — loading the payload and starting the broadcast. Rendering
  frames needs no user gesture, so `send` really is hands-free.
* **one click** — fullscreen. Browsers reject `requestFullscreen()` without a
  real gesture, so the page shows a large *Go fullscreen* button. Press it: the
  size of the frame is what a camera can read.
* **one click** — the camera permission, the first time an origin asks. After
  that, `receive camera` starts capturing with no click.
* **one click** — `receive screen`. `getDisplayMedia` will not open its window
  picker without a real gesture, so the page shows a *Start screen capture*
  button, and then the OS picker appears. Unavoidable, and said out loud.

## Receive from a screen if you can — it is 21x faster

A screen grab is pixel-perfect, so the decoder skips geometry correction. The
app's measured figures: **2.65 MB/s** on the screen path against **125.8 KB/s**
through a camera. If you already reach the sending machine over VNC/RDP, capture
the window instead of pointing a phone at a monitor.

## No certificates, ever

`http://localhost` is already a secure context, so a desktop can **send or
receive** — camera or screen — with no TLS at all. A phone receives from the
public HTTPS site. lightpipe therefore generates nothing, installs nothing, and
never writes a private key anywhere.

`--https` exists only to serve a certificate you already have, and errors if you
do not pass both `--cert` and `--key`.

## `receive --out <dir>`

The page POSTs the completed file back and the CLI writes it to disk — no
download dialog. It is off unless you ask for it, loopback-only by default,
gated by a per-run token, the filename is reduced to one harmless path segment,
nothing is ever overwritten, and the bytes are checked against a SHA-256 the
page reports before anything is written. The 6-character display code is
printed so you can compare it with the sending screen — that comparison is the
actual integrity check.

## `--https`

Bring your own: `lightpipe --https --cert ./cert.pem --key ./key.pem`. Nothing
is generated, no CA is created, and no key is written to disk. Without both
flags it fails with a message saying so.

## Options

| flag | meaning |
|---|---|
| `--text <s>` | send this string instead of a file |
| `receive camera` / `receive screen` | which source to capture from |
| `-O, --out <dir>` | receive: write the completed file here |
| `--once` | receive: exit after one file is written |
| `--name` / `--type` | override the payload's name / content type |
| `-p, --port <n>` | port to listen on (default `8787`) |
| `-H, --host <addr>` | address to bind; `0.0.0.0` exposes it on the LAN |
| `--https` | serve over TLS with `--cert`/`--key` (both required) |
| `--cert` / `--key` | the certificate and key to serve |
| `-o, --open` / `--no-open` | open, or do not open, a browser |
| `--no-qr` | do not print the terminal QR code |
| `--no-isolation` | drop the COOP/COEP headers |
| `-q, --quiet` | no per-request logging |

## Cross-origin isolation

Responses carry `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` **by default**, so the page is
`crossOriginIsolated` and `SharedArrayBuffer` is available — something GitHub
Pages cannot do, and the door to real cross-thread zero-copy later. Everything
the app loads is same-origin, so nothing is excluded. Verified: the app loads on
the real wasm core and completes a round trip with them on.

Full documentation: [`docs/cli.md`](https://github.com/muthuishere/lightpipe/blob/main/docs/cli.md).

MIT.
