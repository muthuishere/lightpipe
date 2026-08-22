# lightpipe

Move a file between two devices using **nothing but light** — one screen animates
a grid of coloured cells, the other device's camera reads them. No network, no
Bluetooth, no NFC, no pairing, no cable, at any point.

This package is the **offline launcher**: it serves the whole web app — React
bundle *and* the Rust/WebAssembly core — from files inside the package, so the
tool works on a machine with no internet at all. Zero telemetry, no update
check, no outbound socket, ever.

```bash
npx lightpipe send report.pdf      # serve, open a browser, START BROADCASTING
npx lightpipe send --text "hi"     # a literal string, sent as markdown
cat notes.md | npx lightpipe send  # stdin
npx lightpipe receive camera      # capture from the webcam (the default)
npx lightpipe receive screen      # capture a screen/window — 21x faster
npx lightpipe receive --out ./in  # write the finished file straight to disk
npx lightpipe serve                # just serve; choose a mode in the browser
npx lightpipe --host 0.0.0.0       # expose on the LAN; prints the LAN URL + a QR
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

## Which device does which job

The **desktop is the sender** — it only renders frames, so it needs no camera,
and `http://localhost` is already a secure context. The default costs nothing
and solves this case completely.

The **phone is the receiver** — it needs a camera, and a browser only hands the
camera to a *secure context*. `http://<lan-ip>` is not one. So either the phone
opens the public HTTPS site (needs internet once, then it is cached), or you run
`--https` here and teach the phone to trust the certificate.

## `receive --out <dir>`

The page POSTs the completed file back and the CLI writes it to disk — no
download dialog. It is off unless you ask for it, loopback-only by default,
gated by a per-run token, the filename is reduced to one harmless path segment,
nothing is ever overwritten, and the bytes are checked against a SHA-256 the
page reports before anything is written. The 6-character display code is
printed so you can compare it with the sending screen — that comparison is the
actual integrity check.

## `--https`

Generates a **local certificate authority** and a leaf it signs, user-level, in
`~/.config/lightpipe/` (`ca.key` is `0600` in a `0700` directory). No sudo, no
system trust store, no OpenSSL, no network. The leaf covers `localhost`,
`127.0.0.1`, `::1` and every current LAN IPv4; if the machine's address changes
the leaf is regenerated automatically from the same CA, so the phone does not
have to be re-taught. A tiny plain-HTTP listener serves `GET /ca.crt` (a phone
cannot fetch a CA over TLS it does not yet trust) and the terminal prints a QR
for it.

**The tradeoff, plainly:** installing that CA on a device means anything holding
`~/.config/lightpipe/ca.key` can mint a certificate that device will trust for
any site. Remove it from the phone when you are done — the terminal prints how.
`--cert` / `--key` bypass all of this.

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
| `--https` | serve over TLS |
| `--cert` / `--key` | bring your own certificate |
| `--ca-port <n>` | plain-HTTP port serving `/ca.crt` (default port+1) |
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
