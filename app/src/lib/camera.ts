/**
 * Camera acquisition, and the automatic behaviours.
 *
 * A flashing cell grid is awkward input for autofocus, auto-exposure and
 * auto-white-balance — they hunt. But a real capture proved that pinning focus
 * is far worse than letting it hunt (see `applyCameraMode`), so the default is
 * now auto and pinning is an explicit choice.
 *
 * Support is patchy and honest reporting matters more than the attempt, so the
 * report carries what was asked, what applied, and what the camera says it is
 * actually doing.
 */

export interface LockReport {
  /** which mode was asked for */
  mode: CameraMode;
  /** what the camera reports it is ACTUALLY doing, read back after applying */
  achieved?: string[];
  requested: string[];
  applied: string[];
  refused: string[];
  unsupported: string[];
  settings: Record<string, unknown>;
  note: string;
}

type ExtendedCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
  exposureMode?: string[];
  whiteBalanceMode?: string[];
  focusDistance?: { min: number; max: number };
};

export async function openCamera(deviceId?: string): Promise<MediaStream> {
  const video: MediaTrackConstraints = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
    facingMode: deviceId ? undefined : "environment",
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

export type CameraMode = "auto" | "pinned";

/**
 * Camera modes, and why the default changed.
 *
 * THE EVIDENCE. A photograph of a real Android capture showed all four corner
 * markers cleanly framed and the image badly OUT OF FOCUS — cells smeared into
 * each other — while the app reported `focusMode=manual, exposureMode=manual,
 * whiteBalanceMode=manual · refused: none`. 385 frames seen, 385 unreadable.
 *
 * Pinning focus to `manual` does not mean "hold the focus you have"; it fixes
 * the lens at whatever `focusDistance` the device happened to hold, and on a
 * phone that is rarely right for a screen at arm's length. The lock applied
 * successfully and destroyed the capture.
 *
 * The original reasoning — automatics hunt against a flashing screen — is real
 * but secondary: a hunting camera is sharp most of the time, a mis-pinned one
 * is sharp never. And a screen at a fixed distance gives autofocus very little
 * to hunt for. Sharpness wins.
 *
 * White balance is the same trade and we need it even less: the calibration
 * strip (ADR-0003) fits a correction per frame, so drift is already absorbed —
 * pinning it only risks locking in a bad value.
 *
 * So AUTO is the default, PINNED stays available from the setup screen, and
 * whichever is chosen the achieved state is reported rather than assumed.
 */
export async function applyCameraMode(
  track: MediaStreamTrack,
  mode: CameraMode = "auto",
): Promise<LockReport> {
  const report: LockReport = {
    mode,
    requested: [],
    applied: [],
    refused: [],
    unsupported: [],
    settings: {},
    note: "",
  };

  const caps = (
    typeof track.getCapabilities === "function" ? track.getCapabilities() : {}
  ) as ExtendedCapabilities;

  /**
   * Preference order per control.
   *
   * In AUTO, focus is never pinned — that is the whole point. `continuous`
   * first, `single-shot` as a fallback (it converges once and then stops
   * hunting, which is the best of both).
   */
  const plan: Array<{ name: string; supported?: string[]; order: string[] }> =
    mode === "pinned"
      ? [
          { name: "focusMode", supported: caps.focusMode, order: ["manual", "single-shot", "continuous"] },
          { name: "exposureMode", supported: caps.exposureMode, order: ["manual", "single-shot", "continuous"] },
          {
            name: "whiteBalanceMode",
            supported: caps.whiteBalanceMode,
            order: ["manual", "single-shot", "continuous"],
          },
        ]
      : [
          { name: "focusMode", supported: caps.focusMode, order: ["continuous", "single-shot"] },
          { name: "exposureMode", supported: caps.exposureMode, order: ["continuous", "single-shot"] },
          {
            name: "whiteBalanceMode",
            supported: caps.whiteBalanceMode,
            order: ["continuous", "single-shot"],
          },
        ];

  for (const c of plan) {
    if (!c.supported || !Array.isArray(c.supported)) {
      report.unsupported.push(c.name);
      continue;
    }
    const target = c.order.find((v) => c.supported!.includes(v));
    if (!target) {
      report.unsupported.push(`${c.name} (offers: ${c.supported.join("/")})`);
      continue;
    }
    report.requested.push(`${c.name}=${target}`);
    try {
      await track.applyConstraints({ advanced: [{ [c.name]: target }] } as MediaTrackConstraints);
      report.applied.push(`${c.name}=${target}`);
    } catch {
      report.refused.push(`${c.name}=${target}`);
    }
  }

  // Report what the camera actually ended up doing, not what we asked for.
  const settled = (track.getSettings?.() ?? {}) as Record<string, unknown>;
  report.settings = settled;
  report.achieved = ["focusMode", "exposureMode", "whiteBalanceMode"]
    .map((k) => (settled[k] === undefined ? null : `${k}=${String(settled[k])}`))
    .filter((v): v is string => v !== null);

  if (mode === "auto") {
    report.note =
      report.applied.length > 0
        ? "Autofocus is on. A sharp picture matters more than a steady one — a pinned focus is what stopped a real phone from ever decoding."
        : "This camera exposes no focus or exposure controls. It will do whatever it does; hold steady and keep the light constant.";
  } else {
    report.note =
      report.applied.length > 0
        ? "Pinned. This stops the camera hunting against the flashing screen, but if the picture looks soft, switch back to autofocus — a pinned focus can sit at the wrong distance."
        : "This camera exposes no manual controls, so nothing could be pinned.";
  }
  return report;
}

/* ------------------------------------------------------- screen capture --- */

/**
 * The other way in: capture a screen or a window instead of pointing a lens at
 * one.
 *
 * This is for the case where the two machines are already connected by a remote
 * desktop session — the air-gapped box is on screen inside a VNC/RDP window, and
 * the file crosses as PIXELS through that video channel. It never becomes a file
 * transfer, so the gap holds; it is the same optical link with the air replaced
 * by a video codec.
 *
 * Two consequences, both good:
 *  - the grab is pixel-perfect, so there is no lens, no perspective and no
 *    lighting to correct for, and the decoder can skip finding the grid;
 *  - there are no automatics to lock, so none of the camera dance applies.
 *
 * The browser shows a "you are sharing your screen" indicator that cannot be
 * suppressed, and typically caps around 30 FPS. Both are fine.
 */
export function screenCaptureSupported(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

export async function openScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 } },
    audio: false,
  });
}

/** What the user actually picked, for the "capturing X" state. */
export function screenLabel(stream: MediaStream): string {
  const track = stream.getVideoTracks()[0];
  if (!track) return "a window";
  const s = (track.getSettings?.() ?? {}) as { displaySurface?: string; width?: number; height?: number };
  const surface =
    s.displaySurface === "monitor"
      ? "a whole screen"
      : s.displaySurface === "window"
        ? "a window"
        : s.displaySurface === "browser"
          ? "a browser tab"
          : track.label || "a window";
  const size = s.width && s.height ? ` at ${s.width}x${s.height}` : "";
  return `${surface}${size}`;
}
