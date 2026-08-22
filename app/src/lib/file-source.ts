/**
 * Reading the file to send.
 *
 * ADR-0008 is explicit: `file.stream()`, never `readAsArrayBuffer` — files may
 * be multi-GB. We stream.
 *
 * BUT: the frozen contract's `OpticalSender.create(bytes: Uint8Array, ...)`
 * takes the WHOLE file as one buffer, so after streaming we still have to
 * materialise it. That is a real gap between the contract and ADR-0008 and it
 * is reported rather than hidden: `SAFE_LIMIT` below is the point past which we
 * refuse instead of silently OOM-ing the tab.
 *
 * The fix belongs on the wasm side (a chunk-fed sender), not here.
 */

/** Above this we stop, because the contract cannot express a streaming send. */
export const SAFE_LIMIT = 512 * 1024 * 1024;

export interface ReadProgress {
  read: number;
  total: number;
}

export async function readFileStreaming(
  file: File,
  onProgress: (p: ReadProgress) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const total = file.size;
  const out = new Uint8Array(total);
  let read = 0;
  const reader = file.stream().getReader();
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      out.set(value, read);
      read += value.length;
      onProgress({ read, total });
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

export interface QuotaReport {
  quota: number;
  usage: number;
  free: number;
  enough: boolean;
}

/** ADR-0008: quota must be checked before starting and surfaced. */
export async function checkQuota(needed: number): Promise<QuotaReport | null> {
  if (!navigator.storage?.estimate) return null;
  const est = await navigator.storage.estimate();
  const quota = est.quota ?? 0;
  const usage = est.usage ?? 0;
  const free = Math.max(0, quota - usage);
  return { quota, usage, free, enough: needed === 0 || free > needed * 1.05 };
}
