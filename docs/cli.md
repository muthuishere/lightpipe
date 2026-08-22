# `lightpipe` — the offline CLI

`npx lightpipe` serves the whole web app — React bundle *and* the Rust/WASM
core — from files inside the npm package. There is no CDN, no fetch, no update
check and no telemetry: unplug the machine and it behaves identically.

The package lives in [`cli/`](../cli). ADR-0007 keeps the product browser-only;
this does not change that. The CLI is a *launcher* — it serves the same app and,
in `send` / `receive` mode, drives it through its own UI exactly as a human
would. Nothing under `app/` is modified or aware of it.

```bash
npx lightpipe send report.pdf      # serve, open a browser, start broadcasting
npx lightpipe send --text "hi"     # a literal string, sent as markdown
cat notes.md | npx lightpipe send  # stdin
npx lightpipe receive camera       # capture from the webcam (the default)
npx lightpipe receive screen       # capture a screen/window — 21x faster, see below
npx lightpipe receive --out ./in   # write the finished file straight to disk
npx lightpipe serve                # just serve; choose a mode in the browser
npx lightpipe --host 0.0.0.0       # expose on the LAN; prints the LAN URL + a QR
```

## No certificates, ever

Every real path is already a **secure context**, which is what `getUserMedia`
and `getDisplayMedia` require:

| path | origin | secure context |
|---|---|---|
| desktop sender | `http://localhost` | yes |
| desktop receiver, camera or screen | `http://localhost` | yes |
| phone receiver | the public HTTPS site | yes |

So lightpipe generates no certificate, creates no certificate authority, and
**never writes a private key anywhere**. There is nothing to trust, nothing to
install, and nothing to remove afterwards — which is the right posture for a
tool whose entire premise is the air gap.

`--https` is bring-your-own only (see below).

## Receive from a screen if you can — it is 21x faster

A screen grab is pixel-perfect, so the decoder skips geometry correction
entirely. The app's own measured figures: **2.65 MB/s** on the screen path
against **125.8 KB/s** through a camera. If you are already looking at the
sending machine over VNC/RDP — common with an air-gapped box — capture the
window directly rather than pointing a phone at a monitor.

```bash
lightpipe receive screen --out ./incoming
```

Those two numbers are the app's, not the CLI's: the CLI selects the source and
reports them, it does not measure anything itself.

## What is automatic and what needs a click

| | |
|---|---|
| loading the payload and **starting the broadcast** | automatic — rendering frames needs no user gesture |
| **fullscreen** | one click. Browsers reject `requestFullscreen()` without a real gesture, so the page shows a large "Go fullscreen" button. Press it: the size of the frame is what a camera can read, so this is throughput, not cosmetics |
| **camera permission** | one click, the first time an origin asks. After that `receive camera` starts capturing with no click |
| **`receive screen`** | one click. `getDisplayMedia` refuses to open its window picker without a real gesture, so the page shows a "Start screen capture" button — and then the OS picker appears. Both are unavoidable, and the CLI says so rather than pretending otherwise |

## How the CLI hands a payload to a browser-only app

The app cannot read a path (ADR-0007). So the CLI holds the payload and the page
fetches it:

* `GET /__payload` — the bytes, with `X-Lp-Name` and the content type.
* In `receive` mode the same script selects the source (`camera` or `screen`) in
  the app's own dropdown before starting.
* An injected `<script src="/__bridge.js">` (added to `index.html` **only** in
  `send` / `receive` mode) puts them into the app's own file input, or its
  textarea for untyped text, and clicks *Start sending*. Untyped text goes in
  through the textarea deliberately, so the app applies its own
  `note.md` / `text/markdown` envelope defaults rather than the CLI inventing a
  second format.
* `POST /__status` — what the page knows and the blind terminal does not: the
  6-character display code, the on-the-wire size, and hence the estimate.

These endpoints exist in this server and nowhere else. The GitHub Pages build
contains no trace of them, because they are not in `app/` at all.

## `receive --out <dir>` — the thing only the CLI can do

With `--out`, the page `POST`s the completed file to `/__save` and the CLI writes
it to disk. No download dialog, no `~/Downloads`.

Guarantees, in order of how badly they would hurt if they were missing:

* **Off unless you ask.** No `--out`, no endpoint.
* **Loopback by default.** Refused outright if the server was bound to a
  non-loopback address without an explicit `--host`. Pass `--host` yourself and
  the terminal warns you plainly about what you just enabled.
* **Per-run token.** A 24-byte token, minted at startup, reaches only the
  injected script; `/__save` compares it in constant time.
* **The name is not trusted.** Reduced to a single path segment, absolute paths
  and `..` stripped, and the resolved parent directory is re-checked against
  `--out` before anything is written.
* **Never overwrites.** `report.pdf`, `report-1.pdf`, … and the write itself
  uses `wx`.
* **The bytes are checked.** The page sends a SHA-256 of exactly what it
  uploaded; the CLI recomputes it and writes nothing on a mismatch.
* **The 6-character code is printed**, because comparing it with the sending
  screen is the actual integrity check (ADR-0005) — see the honesty note below.
* **Never hangs.** If the `POST` fails for any reason, the bridge restores the
  app's own download path, falls back to it, and says so on the page and in the
  terminal.

### An honest note about that code

The CLI verifies the **transport hop** — page to disk — with SHA-256, so the
file it writes is byte-identical to what the page produced. It does **not**
recompute the 6-character display code, which is Crockford base32 over the top
30 bits of a BLAKE3 hash of the *envelope-wrapped* payload, computed inside the
wasm core. Doing that in Node would mean a BLAKE3 dependency plus a duplicate of
the envelope format, and a second implementation of an integrity check is a
liability, not an asset. So the code is *reported*, printed, and compared by a
human against the sending screen — exactly as ADR-0005 designed it.

## Headers

| header | value | why |
|---|---|---|
| `Content-Type` for `.wasm` | `application/wasm` | otherwise `instantiateStreaming` refuses |
| `Cache-Control` on `index.html` | `no-store` | a reinstall must be picked up; in send/receive mode the body is generated per run |
| `Cache-Control` on `/assets/*` | `immutable` | vite content-hashes them |
| `Cross-Origin-Opener-Policy` | `same-origin` | **on by default** |
| `Cross-Origin-Embedder-Policy` | `require-corp` | **on by default** |
| `Cross-Origin-Resource-Policy` | `same-origin` | what lets same-origin subresources through COEP |

Cross-origin isolation is something GitHub Pages cannot give you, and it is what
`SharedArrayBuffer` needs — the door to real cross-thread zero-copy later.
Verified in Chromium against the CLI's own server: `crossOriginIsolated === true`,
`SharedArrayBuffer` defined, the app loads on the **real wasm core**, a loopback
round trip completes, and there are no console errors. `--no-isolation` turns it
off if some future browser disagrees.

## `--https` — bring your own certificate

```bash
lightpipe --https --cert ./cert.pem --key ./key.pem
```

That is the whole feature. Without **both** flags it exits 2 with a message
explaining that it does not generate certificates and that you almost certainly
do not need TLS:

```
lightpipe: --https serves a certificate you supply — pass both --cert and --key.
  It does not generate one, and never writes a private key anywhere.
  You probably do not need TLS at all: http://localhost is already a secure
  context, so a desktop can send or receive there, and a phone should use the
  public HTTPS site.
```

If a second machine opens the LAN URL over plain `http://`, the terminal says
plainly that it can render frames but cannot use its camera or capture its
screen there, and that the fix is to run lightpipe on *that* machine and use its
own `http://localhost`.

## Not supported (deferred)

LAN access from a phone or a second machine over HTTPS is deliberately not
supported today. It is not needed: loopback (`http://localhost`, `127.0.0.1`,
`::1`) is a W3C secure context, so camera, screen capture, OPFS and
`SharedArrayBuffer` all work over plain HTTP, and a phone uses the hosted GitHub
Pages build, which is already HTTPS. A generated local CA was removed rather
than kept because it means a private key on disk and a trust prompt on every
device — a poor trade for a security-adjacent tool when nothing currently needs
it. `--cert` / `--key` remains for anyone who brings their own certificate.
Revisit only if an enterprise case demands it.

## Building and publishing

`prepack` runs `cli/scripts/build-app.mjs`, which builds the wasm bundle (only
when `app/src/wasm` is missing) and then runs vite with `BASE_PATH=/`, writing
straight into `cli/public/`. It never overwrites `app/dist`, which stays the
`/lightpipe/`-based Pages build.

```bash
npm --prefix cli install
npm --prefix cli run build   # produces cli/public/
npm --prefix cli pack        # lightpipe-<version>.tgz, ~318 kB
```

## A Taskfile target, if you want one

```yaml
  cli:build:
    desc: 'Build the offline npm CLI (base-/ app build baked into cli/public)'
    deps: [wasm:build]
    cmds:
      - npm --prefix cli install
      - npm --prefix cli run build

  cli:pack:
    desc: 'Pack the CLI tarball and show what is in it'
    deps: [cli:build]
    cmds:
      - npm --prefix cli pack
      - tar tzf cli/lightpipe-*.tgz

  cli:run:
    desc: 'Serve the app locally from the CLI (offline, no internet needed)'
    deps: [cli:build]
    cmds:
      - node cli/bin/lightpipe.js {{.CLI_ARGS}}
```
