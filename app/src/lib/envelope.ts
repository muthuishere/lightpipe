/**
 * The app-side envelope.
 *
 *     [u32 LE metadata length][metadata JSON, UTF-8][payload bytes]
 *     metadata = { name: string, mime: string }
 *
 * WHY THIS IS HERE AND NOT IN THE MANIFEST
 * ----------------------------------------
 * `docs/contracts/wasm-api.md` is frozen and `Manifest` carries no filename and
 * no MIME type. The sender gathers bytes from a file picker, a textarea, a
 * clipboard paste or a drop — four affordances, one path — and the receiver has
 * to know what it is holding to do anything better than "download blob".
 *
 * Both peers are the same app, so we wrap before `OpticalSender.create` and
 * unwrap after taking the bytes out of OPFS. The optical layers never see it —
 * to them it is payload like any other, and the 6-char display code covers the
 * envelope exactly as it covers everything else.
 *
 * This SHOULD eventually move into the manifest so a non-browser receiver can
 * read it too. That is a contract change, not an app change.
 */

export interface EnvelopeMeta {
  name: string;
  mime: string;
}

const MAX_META = 64 * 1024;

/** No better information available? It is a note, and notes are markdown. */
export const DEFAULT_META: EnvelopeMeta = { name: "note.md", mime: "text/markdown" };

export function envelopeOverhead(meta: EnvelopeMeta): number {
  return 4 + new TextEncoder().encode(JSON.stringify(meta)).length;
}

export function wrap(meta: EnvelopeMeta, payload: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + json.length + payload.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(payload, 4 + json.length);
  return out;
}

export interface ParsedHeader {
  meta: EnvelopeMeta;
  offset: number;
}

/**
 * Parse the envelope header. Returns null when the bytes do not look like one,
 * and the receiver then treats the whole transfer as an anonymous binary file
 * rather than guessing.
 */
export function readHeader(head: Uint8Array, totalLength: number): ParsedHeader | null {
  if (head.length < 4) return null;
  const len = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0, true);
  if (len === 0 || len > MAX_META || 4 + len > totalLength || head.length < 4 + len) return null;
  try {
    const meta = JSON.parse(new TextDecoder().decode(head.subarray(4, 4 + len))) as EnvelopeMeta;
    if (!meta || typeof meta.name !== "string" || typeof meta.mime !== "string") return null;
    return { meta, offset: 4 + len };
  } catch {
    return null;
  }
}

/** Read just enough of the received blob to parse the header. */
export async function unwrapBlob(
  blob: Blob,
): Promise<{ meta: EnvelopeMeta; payload: Blob } | null> {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 4 + 4096)).arrayBuffer());
  const parsed = readHeader(head, blob.size);
  if (!parsed) return null;
  // slice() is lazy — this does not pull a multi-GB payload into memory.
  return { meta: parsed.meta, payload: blob.slice(parsed.offset) };
}

/* ------------------------------------------------------------ type sniffing */

const EXT_MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/plain",
  rs: "text/plain",
  py: "text/plain",
  toml: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
};

/** Sniff from the source's own type first, then the extension, then default. */
export function sniff(name: string, declared?: string): EnvelopeMeta {
  const clean = (name || "").trim() || DEFAULT_META.name;
  if (declared && declared !== "application/octet-stream" && declared !== "") {
    return { name: clean, mime: declared };
  }
  const ext = clean.includes(".") ? clean.split(".").pop()!.toLowerCase() : "";
  const byExt = EXT_MIME[ext];
  if (byExt) return { name: clean, mime: byExt };
  if (declared === "application/octet-stream") return { name: clean, mime: declared };
  return { name: clean, mime: DEFAULT_META.mime };
}

export function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

export function isText(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/x-yaml"
  );
}

export function isMarkdown(mime: string): boolean {
  return mime === "text/markdown";
}
