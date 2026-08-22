import { createReadStream, promises as fs } from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { contentType } from "./mime.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "bridge.js");

/**
 * A static server for one directory, plus three endpoints that exist ONLY while
 * the CLI is serving:
 *
 *   GET  /__payload   the file/text the user named on the command line
 *   POST /__save      the completed transfer, written to --out
 *   POST /__status    what the page knows and the blind terminal does not
 *   GET  /__bridge.js the script that drives the page (never part of app/)
 *
 * They are absent from the GitHub Pages build by construction — they are not in
 * the app at all, they are in this file — and absent here too unless the
 * matching subcommand asked for them.
 *
 * No proxying, no directory listing, and no outbound socket of any kind: the
 * whole point of the product is that it works with the machine unplugged.
 */
export function createServer(opts) {
  const {
    root,
    tls = null,
    crossOriginIsolated = true,
    quiet = false,
    mode = "serve", // serve | send | receive
    source = "camera", // receive only: camera | screen
    token = crypto.randomBytes(16).toString("hex"),
    payload = null, // { path?, buffer?, name, mime, size, asText }
    saveDir = null, // absolute dir; null = POST /__save is disabled
    once = false,
    onSaved = () => {},
    onStatus = () => {},
  } = opts;
  const ROOT = resolve(root);
  const MAX_SAVE = 2 * 1024 * 1024 * 1024;

  const handler = async (req, res) => {
    const started = Date.now();
    let status = 500;
    try {
      status = await route(req, res);
    } catch (err) {
      status = 500;
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`500 ${err.message}\n`);
      } else res.destroy();
    }
    if (!quiet) console.log(`  ${String(status).padEnd(3)} ${req.method} ${req.url} ${Date.now() - started}ms`);
  };

  const plain = (res, code, body) => {
    securityHeaders(res, crossOriginIsolated);
    res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(body.endsWith("\n") ? body : body + "\n");
    return code;
  };

  async function route(req, res) {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/__bridge.js" && req.method === "GET" && mode !== "serve") return sendFile(req, res, BRIDGE, false);
    if (path === "/__payload") return payloadEndpoint(req, res);
    if (path === "/__save") return saveEndpoint(req, res);
    if (path === "/__status") return statusEndpoint(req, res);
    if (path.startsWith("/__")) return plain(res, 404, "404 not found");
    return staticEndpoint(req, res);
  }

  /* ---- GET /__payload --------------------------------------------------- */
  async function payloadEndpoint(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") return plain(res, 405, "405 method not allowed");
    if (!payload) return plain(res, 404, "no payload: this server was not started with `lightpipe send`");
    securityHeaders(res, crossOriginIsolated);
    res.setHeader("Content-Type", payload.mime);
    res.setHeader("Content-Length", payload.size);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Lp-Name", encodeURIComponent(payload.name));
    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return 200;
    }
    res.writeHead(200);
    if (payload.buffer) res.end(payload.buffer);
    else await pipe(createReadStream(payload.path), res);
    return 200;
  }

  /* ---- POST /__save ----------------------------------------------------- */
  async function saveEndpoint(req, res) {
    if (req.method !== "POST") return plain(res, 405, "405 method not allowed");
    if (!saveDir) return plain(res, 404, "writing to disk is off: start with `lightpipe receive --out <dir>`");
    // A page on any other origin must not be able to write files here. The
    // token is minted per run and only ever reaches the injected script.
    const given = req.headers["x-lp-token"];
    if (typeof given !== "string" || given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
      return plain(res, 403, "403 bad or missing token");
    }
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_SAVE) return plain(res, 413, `413 too large (> ${MAX_SAVE} bytes)`);

    const chunks = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > MAX_SAVE) {
        req.destroy();
        return plain(res, 413, "413 too large");
      }
      chunks.push(c);
    }
    const body = Buffer.concat(chunks);

    // The page tells us what it thinks it sent; refuse to write anything else.
    const claimed = String(req.headers["x-lp-sha256"] ?? "");
    const actual = crypto.createHash("sha256").update(body).digest("hex");
    if (!claimed || claimed.toLowerCase() !== actual) {
      return plain(res, 422, `422 the bytes do not match the digest the page reported (${claimed || "none"} vs ${actual}) — nothing was written`);
    }

    const name = safeName(decodeURIComponent(String(req.headers["x-lp-name"] ?? "")));
    const target = await freePath(join(saveDir, name));
    // Belt and braces: after all the sanitising, it must still be inside --out.
    if (dirname(resolve(target)) !== resolve(saveDir)) return plain(res, 400, "400 refused: the name resolves outside --out");
    await fs.writeFile(target, body, { flag: "wx" });

    const code = String(req.headers["x-lp-code"] ?? "").replace(/[^0-9A-Z]/g, "").slice(0, 6);
    onSaved({ path: target, bytes: body.length, code, sha256: actual, once });
    return plain(res, 200, target);
  }

  /* ---- POST /__status --------------------------------------------------- */
  async function statusEndpoint(req, res) {
    if (req.method !== "POST") return plain(res, 405, "405 method not allowed");
    if (mode === "serve") return plain(res, 404, "404 not found");
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > 64 * 1024) {
        req.destroy();
        return plain(res, 413, "413 too large");
      }
      chunks.push(c);
    }
    try {
      onStatus(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      return plain(res, 400, "400 not json");
    }
    return plain(res, 204, "");
  }

  /* ---- static ----------------------------------------------------------- */
  async function staticEndpoint(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      securityHeaders(res, crossOriginIsolated);
      res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
      res.end("405 method not allowed\n");
      return 405;
    }
    const raw = decodeURIComponent((req.url ?? "/").split("?")[0].split("#")[0]);
    let rel = normalize(raw).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    if (rel === "" || raw.endsWith("/")) rel = join(rel, "index.html");

    let file = resolve(ROOT, rel);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      securityHeaders(res, crossOriginIsolated);
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("403 forbidden\n");
      return 403;
    }
    let stat = await fs.stat(file).catch(() => null);
    if (stat?.isDirectory()) {
      file = join(file, "index.html");
      stat = await fs.stat(file).catch(() => null);
    }
    if (!stat?.isFile()) {
      // Single-page app: a path with no extension is a client route, not a 404.
      if (!extname(rel)) {
        file = join(ROOT, "index.html");
        stat = await fs.stat(file).catch(() => null);
      }
      if (!stat?.isFile()) {
        securityHeaders(res, crossOriginIsolated);
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("404 not found\n");
        return 404;
      }
    }
    return sendFile(req, res, file, file === join(ROOT, "index.html"));
  }

  async function sendFile(req, res, file, isEntry) {
    securityHeaders(res, crossOriginIsolated);
    res.setHeader("Content-Type", contentType(extname(file)));
    // index.html is never cached (a reinstall must be picked up, and in send /
    // receive mode its body is generated per run); everything else in a vite
    // build is content-hashed, so it is immutable.
    res.setHeader("Cache-Control", isEntry || file === BRIDGE ? "no-store, must-revalidate" : "public, max-age=31536000, immutable");

    if (isEntry && mode !== "serve") {
      const body = Buffer.from(inject(await fs.readFile(file, "utf8")), "utf8");
      res.setHeader("Content-Length", body.length);
      res.writeHead(200);
      res.end(req.method === "HEAD" ? undefined : body);
      return 200;
    }
    const stat = await fs.stat(file);
    res.setHeader("Content-Length", stat.size);
    if (!isEntry) res.setHeader("Last-Modified", stat.mtime.toUTCString());
    res.writeHead(200);
    if (req.method === "HEAD") {
      res.end();
      return 200;
    }
    await pipe(createReadStream(file), res);
    return 200;
  }

  function inject(html) {
    const cfg = { mode, source, token, save: Boolean(saveDir), asText: Boolean(payload?.asText) };
    const tag =
      `\n<script>window.__LIGHTPIPE__=${JSON.stringify(cfg).replace(/</g, "\\u003c")};</script>` +
      `\n<script src="/__bridge.js"></script>\n`;
    return html.includes("</body>") ? html.replace("</body>", tag + "</body>") : html + tag;
  }

  return tls ? https.createServer(tls, handler) : http.createServer(handler);
}

function securityHeaders(res, crossOriginIsolated) {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // CORP is what lets same-origin subresources through COEP: require-corp.
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (crossOriginIsolated) {
    // GitHub Pages cannot set these. With both on the page is
    // `crossOriginIsolated`, which is what SharedArrayBuffer needs. Everything
    // the app loads is same-origin, so nothing is excluded by turning them on.
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  }
}

/** Strip a hostile name down to one harmless path segment. */
export function safeName(raw) {
  let n = String(raw || "")
    .replace(/\0/g, "")
    .replace(/[/\\]/g, "_");
  n = basename(normalize(n));
  if (!n || n === "." || n === ".." || n.startsWith("..")) n = "received.bin";
  if (n.length > 180) n = n.slice(0, 100) + "-" + n.slice(-60);
  return n;
}

/** Never overwrite: name, name-1, name-2, ... */
export async function freePath(target) {
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? target : `${stem}-${i}${ext}`;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`a thousand files already have that name in ${dirname(target)}`);
}

const pipe = (src, dst) =>
  new Promise((ok, bad) => {
    src.on("error", bad);
    src.on("end", ok);
    src.pipe(dst);
  });
