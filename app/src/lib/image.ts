/**
 * Optional image re-encode on the send side.
 *
 * ADR-0014 removed the compressibility probe: every chunk is gzipped now,
 * always. That is the right call for the encoder, but it does not help a JPEG —
 * gzip cannot shrink an already-compressed image, so the payload size is the
 * payload size, and on this channel size IS time. A 4 MB phone photo is 31 s of
 * holding a camera on a good link and nearly four minutes on a potato.
 *
 * The browser can fix that in one call. Re-encoding to WebP at q≈0.8 typically
 * lands around a tenth of the size. It is OFFERED, never applied silently — a
 * person sending an original is entitled to send the original.
 */

export interface Reencoded {
  blob: Blob;
  bytes: Uint8Array;
  width: number;
  height: number;
  mime: string;
}

export interface SourceImage {
  width: number;
  height: number;
}

export async function probeImage(source: Blob): Promise<SourceImage | null> {
  try {
    const bmp = await createImageBitmap(source);
    const out = { width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  } catch {
    return null;
  }
}

/**
 * @param maxDim longest edge in px, or 0 to keep the original size
 * @param quality 0..1
 */
export async function reencode(
  source: Blob,
  quality: number,
  maxDim: number,
): Promise<Reencoded | null> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(source);
  } catch {
    return null; // not something this browser can decode; leave it alone
  }
  const scale = maxDim > 0 ? Math.min(1, maxDim / Math.max(bmp.width, bmp.height)) : 1;
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close();
    return null;
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/webp", quality);
  });
  // Safari before 16 has no WebP encoder; JPEG is everywhere.
  const finalBlob =
    blob && blob.type === "image/webp"
      ? blob
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!finalBlob) return null;

  return {
    blob: finalBlob,
    bytes: new Uint8Array(await finalBlob.arrayBuffer()),
    width: w,
    height: h,
    mime: finalBlob.type,
  };
}

export function swapExtension(name: string, mime: string): string {
  const ext = mime === "image/webp" ? "webp" : mime === "image/jpeg" ? "jpg" : "bin";
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name) + "." + ext;
}
