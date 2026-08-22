import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServer } from "./server.js";
import { contentType } from "./mime.js";
import { isLoopback, lanAddresses, primaryLanAddress, urlHost } from "./net.js";

const require_ = createRequire(import.meta.url);
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

// The two measured ends of the range, straight from app/src/lib/estimate.ts:
// S4's warped clean-decode frontier at 15 FPS. The slow end is the one that
// matters — ADR-0011 promises a potato camera finishes, and this is its price.
const GOOD_BPS = 8748 * 15;
const POTATO_BPS = 1182 * 15;

const OPTIONS = {
  text: { type: "string" },
  out: { type: "string", short: "O" },
  once: { type: "boolean", default: false },
  name: { type: "string" },
  type: { type: "string" },
  port: { type: "string", short: "p", default: "8787" },
  host: { type: "string", short: "H" },
  https: { type: "boolean", default: false },
  cert: { type: "string" },
  key: { type: "string" },
  open: { type: "boolean", short: "o", default: false },
  "no-open": { type: "boolean", default: false },
  qr: { type: "boolean", default: true },
  "no-qr": { type: "boolean", default: false },
  isolation: { type: "boolean", default: true },
  "no-isolation": { type: "boolean", default: false },
  quiet: { type: "boolean", short: "q", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
};

const HELP = String.raw`
  lightpipe — move a file with nothing but light. Serves the app from this
  machine, offline: no internet is needed at any point.

  COMMANDS
    lightpipe send <file>          serve, open a browser, START BROADCASTING
    lightpipe send --text "..."    send a literal string (markdown, as the app does)
    cat notes.md | lightpipe send  read stdin when no file is given
    lightpipe receive camera       capture from the webcam (the default)
    lightpipe receive screen       capture a screen or window — 21x FASTER, see below
    lightpipe receive --out DIR    write the finished file straight into DIR
    lightpipe serve                just serve the app; pick a mode in the browser
    lightpipe                      same as serve

  http://localhost is already a secure context, so a desktop can send OR receive
  (camera or screen) with no certificate at all. A phone receives from the public
  HTTPS site. Nothing here needs TLS.

  OPTIONS
        --text <s>        send this string instead of a file
    -O, --out <dir>       receive: write the completed file here (default: cwd)
        --once            receive: exit after one file is written
        --name <s>        override the name the payload is sent under
        --type <mime>     override the payload's content type
    -p, --port <n>        port to listen on                 (default 8787)
    -H, --host <addr>     address to bind; 0.0.0.0 for LAN  (default 127.0.0.1)
        --https           serve over TLS using --cert / --key (both required)
        --cert <file>     certificate to serve
        --key <file>      private key for --cert
    -o, --open            open a browser (implied by send / receive)
        --no-open         do not open a browser; just print the URL
        --no-qr           do not print the terminal QR code
        --no-isolation    drop the COOP/COEP cross-origin-isolation headers
    -q, --quiet           no per-request logging
    -h, --help            this text
    -v, --version         print the version

  WHAT IS AUTOMATIC AND WHAT IS NOT
    automatic   loading the payload and starting the broadcast — rendering
                frames needs no user gesture, so this really is hands-free.
    one click   fullscreen. Browsers refuse requestFullscreen() without a real
                gesture, so the page shows a big "Go fullscreen" button. Press
                it: a bigger frame is what a camera can actually read.
    one click   the camera permission, the first time an origin asks. After
                that, "receive camera" starts capturing with no click.
    one click   "receive screen". getDisplayMedia refuses to open its window
                picker without a real gesture, so the page shows a "Start screen
                capture" button, and then the OS picker appears. Unavoidable.

  RECEIVE FROM A SCREEN IF YOU CAN — IT IS 21x FASTER
    A screen grab is pixel-perfect, so the decoder skips geometry correction
    entirely. Measured in the app: 2.65 MB/s on the screen path against
    125.8 KB/s through a camera. If you are already looking at the sending
    machine over VNC/RDP — which is common with an air-gapped box — capture the
    window directly with "lightpipe receive screen" instead of pointing a phone
    at a monitor.

  --https IS BRING-YOUR-OWN-CERTIFICATE
    lightpipe does not generate certificates and never writes a private key
    anywhere. --https serves the --cert / --key you already have, and errors if
    you do not supply them.

    You almost certainly do not need it. Every real path is already a secure
    context: a desktop sender or receiver on http://localhost, and a phone on
    the public HTTPS site.

  Nothing here talks to the network. The app, including the WebAssembly core,
  is served from files inside this package.
`;

export async function main(argv) {
  const COMMANDS = new Set(["serve", "send", "receive"]);
  const SOURCES = new Set(["camera", "screen"]);
  let source = "camera";
  let command = "serve";
  let rest = argv;
  if (argv.length && COMMANDS.has(argv[0])) {
    command = argv[0];
    rest = argv.slice(1);
  }

  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    console.error(`lightpipe: ${e.message}\nTry --help.`);
    return 2;
  }
  const a = parsed.values;
  const positionals = parsed.positionals;
  if (a.help) {
    console.log(HELP.trimEnd());
    return 0;
  }
  if (a.version) {
    console.log(pkg.version);
    return 0;
  }

  const root = join(PKG_ROOT, "public");
  if (!existsSync(join(root, "index.html"))) {
    console.error(`lightpipe: the bundled app is missing from ${root}.\n  From a source checkout, build it first:  npm --prefix cli run build`);
    return 1;
  }
  const port = Number(a.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`lightpipe: --port must be 0-65535, got ${a.port}`);
    return 2;
  }

  // --- payload -------------------------------------------------------------
  let payload = null;
  if (command === "send") {
    try {
      payload = await gatherPayload(positionals, a);
    } catch (e) {
      console.error(`lightpipe: ${e.message}`);
      return 2;
    }
  } else if (command === "receive") {
    if (positionals.length > 1) {
      console.error(`lightpipe: receive takes at most one source, got ${positionals.length}`);
      return 2;
    }
    if (positionals.length) {
      if (!SOURCES.has(positionals[0])) {
        console.error(`lightpipe: unknown receive source \`${positionals[0]}\`. Use one of: ${[...SOURCES].join(", ")}`);
        return 2;
      }
      source = positionals[0];
    }
  } else if (positionals.length) {
    console.error(`lightpipe: \`${command}\` takes no file argument (got ${positionals[0]})`);
    return 2;
  }

  // --- where to write ------------------------------------------------------
  const hostGiven = a.host !== undefined;
  const host = a.host ?? "127.0.0.1";
  let saveDir = null;
  if (command === "receive" && (a.out !== undefined || a.once)) {
    saveDir = resolve(a.out ?? process.cwd());
    // Writing files on behalf of a web page is the one genuinely dangerous
    // thing here, so it is off unless only this machine can reach the server,
    // or the user named a --host on purpose and owns that decision.
    if (!isLoopback(host) && !hostGiven) {
      console.error("lightpipe: refusing to write to disk while bound to a non-loopback address by default");
      return 2;
    }
    await mkdir(saveDir, { recursive: true });
  }

  const isolate = a.isolation && !a["no-isolation"];
  const token = crypto.randomBytes(24).toString("hex");

  // --- TLS: bring your own, or none. Nothing is ever generated. ----------
  let tls = null;
  let certPath = null;
  if (a.https || a.cert || a.key) {
    if (!a.cert || !a.key) {
      console.error(
        "lightpipe: --https serves a certificate you supply — pass both --cert and --key.\n" +
          "  It does not generate one, and never writes a private key anywhere.\n" +
          "  You probably do not need TLS at all: http://localhost is already a secure\n" +
          "  context, so a desktop can send or receive there, and a phone should use the\n" +
          "  public HTTPS site.",
      );
      return 2;
    }
    try {
      tls = { cert: readFileSync(a.cert), key: readFileSync(a.key) };
    } catch (e) {
      console.error(`lightpipe: could not read the certificate or key: ${e.message}`);
      return 1;
    }
    certPath = resolve(a.cert);
  }

  // --- listen --------------------------------------------------------------
  const server = createServer({
    root,
    tls,
    crossOriginIsolated: isolate,
    quiet: a.quiet,
    mode: command,
    source,
    token,
    payload,
    saveDir,
    once: a.once,
    onStatus: (s) => reportStatus(s, payload),
    onSaved: (r) => {
      console.log(
        `\n  RECEIVED  ${r.path}\n            ${r.bytes.toLocaleString()} B · code ${r.code || "??????"} — compare it with the sending screen (ADR-0005)\n            sha256 ${r.sha256}\n`,
      );
      if (a.once) shutdown(server, 0);
    },
  });

  try {
    await new Promise((ok, bad) => {
      server.once("error", bad);
      server.listen(port, host, ok);
    });
  } catch (e) {
    console.error(listenError(e, host, port));
    return 1;
  }

  const actual = server.address();
  const lan = primaryLanAddress();
  const scheme = tls ? "https" : "http";
  const localUrl = `${scheme}://${isLoopback(host) ? host : "localhost"}:${actual.port}/`;
  const lanUrl = !isLoopback(host) && lan ? `${scheme}://${urlHost(host, lan)}:${actual.port}/` : null;

  banner({ command, source, localUrl, lanUrl, host, lan, tls, certPath, isolate, qr: a.qr && !a["no-qr"], payload, saveDir });

  const wantOpen = !a["no-open"] && (a.open || command !== "serve");
  if (wantOpen) openBrowser(localUrl);
  else if (command !== "serve") console.log(`  --no-open: nothing was launched. Open ${lanUrl ?? localUrl} yourself to start.\n`);

  const stop = () => {
    console.log("\nlightpipe: stopped.");
    shutdown(server, 0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return new Promise(() => {}); // foreground until Ctrl-C
}

function shutdown(server, code) {
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 400).unref();
}

const listenError = (e, host, port) =>
  e.code === "EADDRINUSE"
    ? `lightpipe: port ${port} is already in use. Try --port ${port + 1}.`
    : e.code === "EACCES"
      ? `lightpipe: not allowed to bind ${host}:${port}. Ports below 1024 need root — pick a higher one.`
      : e.code === "EADDRNOTAVAIL"
        ? `lightpipe: ${host} is not an address on this machine.`
        : `lightpipe: ${e.message}`;

/* ---- payload -------------------------------------------------------------- */

async function gatherPayload(positionals, a) {
  if (positionals.length > 1) throw new Error(`send takes one file, got ${positionals.length}`);
  if (a.text !== undefined && positionals.length) throw new Error("give either a file or --text, not both");

  if (a.text !== undefined) {
    const buffer = Buffer.from(a.text, "utf8");
    if (!buffer.length) throw new Error("--text was empty");
    return { buffer, size: buffer.length, name: a.name ?? "note.md", mime: a.type ?? "text/markdown", asText: !a.name && !a.type };
  }
  if (positionals.length) {
    const path = resolve(positionals[0]);
    let st;
    try {
      st = statSync(path);
    } catch {
      throw new Error(`no such file: ${positionals[0]}`);
    }
    if (st.isDirectory()) throw new Error(`${positionals[0]} is a directory. Tar it first:  tar czf - ${positionals[0]} | lightpipe send --name dir.tgz --type application/gzip`);
    if (st.size === 0) throw new Error(`${positionals[0]} is empty`);
    return { path, size: st.size, name: a.name ?? basename(path), mime: a.type ?? guessMime(path), asText: false };
  }
  if (process.stdin.isTTY) throw new Error("nothing to send. Give a file, --text, or pipe something in.");
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw new Error("stdin was empty");
  // Untyped bytes are a note, and notes are markdown — the app's own default.
  const untyped = !a.name && !a.type;
  return { buffer, size: buffer.length, name: a.name ?? "note.md", mime: a.type ?? "text/markdown", asText: untyped };
}

const guessMime = (path) => contentType(extname(path));

/* ---- terminal ------------------------------------------------------------- */

const duration = (s) => (s < 1 ? "<1s" : s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const bytesish = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function reportStatus(s, payload) {
  if (s?.event === "sending") {
    const wire = s.wireBytes || payload?.size || 0;
    console.log(`\n  BROADCASTING  ${s.name} · ${bytesish(s.size ?? 0)}${wire && wire !== s.size ? ` · ${bytesish(wire)} on the wire` : ""}`);
    if (s.code) console.log(`  DISPLAY CODE  ${s.code}   <- the receiving screen must end up showing this`);
    // 1,182 B is one picture on the coarsest measured rung (ADR-0011): below
    // that the screen shows a still image, and "0s-0s" would read as a bug.
    if (wire && wire <= 1182) console.log(`  ESTIMATE      one picture, still — instant on any camera`);
    else if (wire) console.log(`  ESTIMATE      ${duration(wire / GOOD_BPS)}–${duration(wire / POTATO_BPS)}   (good camera – potato camera, both measured)`);
    console.log(
      `\n  This side is blind by design: nothing is sent back (ADR-0005). Watch the\n  RECEIVING device for progress, and press "Go fullscreen" in the browser —\n  a bigger frame is what the camera can actually read.\n  Ctrl-C here stops the broadcast.\n`,
    );
  } else if (s?.event === "receiving" && s.source === "screen") {
    console.log(`\n  READY         the Receive view is open with source "screen or window" selected.${s.save ? "\n                The finished file will be written here." : ""}`);
    console.log(`                ONE CLICK IS NEEDED: press "Start screen capture" in the browser.\n                A browser will not open its window picker without a real gesture,\n                and then the OS picker appears. Both are unavoidable.\n                Worth it — the pixel-perfect path measured 2.65 MB/s against the\n                camera path's 125.8 KB/s, because no geometry correction is needed.\n                Ctrl-C here stops it.\n`);
  } else if (s?.event === "receiving") {
    console.log(`\n  CAPTURING     the browser is reading its camera.${s.save ? " The finished file will be written here." : ""}`);
    console.log(`                The first run for an origin needs ONE click to allow the camera.\n                If you can screen-share the SENDING machine instead, use\n                \`lightpipe receive screen\` — it measured 21x faster.\n                Ctrl-C here stops it.\n`);
  } else if (s?.event === "error") {
    console.log(`\n  the page could not be driven automatically: ${s.message}\n  Carry on in the browser by hand — everything still works there.\n`);
  }
}

function banner({ command, source, localUrl, lanUrl, host, lan, tls, certPath, isolate, qr, payload, saveDir }) {
  const qrcode = () => require_("qrcode-terminal");
  console.log(`\n  lightpipe v${pkg.version} — ${command}, served from this machine, offline.\n`);
  if (payload) console.log(`  payload                 ${payload.name} · ${bytesish(payload.size)}${payload.mime ? ` · ${payload.mime}` : ""}`);
  if (command === "receive") console.log(`  source                  ${source}${source === "screen" ? "   (pixel-perfect: 2.65 MB/s measured, vs 125.8 KB/s through a camera)" : "   (a lens and geometry correction: 125.8 KB/s measured)"}`);
  if (saveDir) console.log(`  writing into            ${saveDir}`);
  console.log(`  this machine            ${localUrl}`);
  if (lanUrl) console.log(`  other devices           ${lanUrl}`);
  else if (isLoopback(host)) console.log(`  other devices           not reachable — bind the LAN with --host 0.0.0.0`);
  else if (!lan) console.log(`  other devices           no LAN address found on this machine`);
  console.log(`  cross-origin isolation  ${isolate ? "on (COOP: same-origin, COEP: require-corp)" : "off"}`);
  if (tls) console.log(`  certificate             yours — ${certPath}`);
  if (saveDir && !isLoopback(host)) {
    console.log(
      `\n  WARNING: --out is on AND this is bound to ${host}. Anything on this network\n  that can reach the page could ask this process to write a file into\n  ${saveDir}. A per-run token gates it, but the page carrying that token is\n  served to whoever asks.`,
    );
  }

  if (qr && lanUrl) {
    console.log(`  Scan this to open the app on another machine:\n`);
    qrcode().generate(lanUrl, { small: true });
    console.log(`     ${lanUrl}\n`);
  }
  if (!tls && !isLoopback(host)) console.log(cameraNote(lanUrl));
}

const cameraNote = (lanUrl) => `
  NOTE — another machine opening ${lanUrl ?? "an http:// LAN URL"} can RENDER
  frames but cannot use its CAMERA or capture its SCREEN: those need a secure
  context, and plain http on a LAN address is not one. That is fine when the
  far machine is the SENDER. If it must RECEIVE, run lightpipe on that machine
  and use its own http://localhost, or open the public https:// site there.
`;

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* opening a browser is a convenience, never a failure */
  }
}
