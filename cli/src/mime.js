// Deliberately small and explicit. The .wasm entry is the load-bearing one:
// browsers refuse WebAssembly.instantiateStreaming on anything else.
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".heic": "image/heic",
  ".avif": "image/avif",
  ".webmanifest": "application/manifest+json",
};

export function contentType(ext) {
  return TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}
