/**
 * Camera acquisition, and the part that matters: turning the camera's automatic
 * behaviours OFF.
 *
 * A flashing cell grid is pathological input for autofocus, auto-exposure and
 * auto-white-balance. All three hunt: the focus motor searches, the exposure
 * pumps, the WB drifts colour-by-colour — and the decoder pays for all of it.
 * Where `MediaTrackConstraints` allows, we pin them.
 *
 * Support is patchy and honest reporting matters more than the attempt, so
 * `lockAutomatics` returns exactly what the browser said it did.
 */

export interface LockReport {
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

export async function lockAutomatics(track: MediaStreamTrack): Promise<LockReport> {
  const report: LockReport = {
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

  const wanted: Array<[string, unknown, string[] | undefined]> = [
    ["focusMode", "manual", caps.focusMode],
    ["exposureMode", "manual", caps.exposureMode],
    ["whiteBalanceMode", "manual", caps.whiteBalanceMode],
  ];

  for (const [name, value, supported] of wanted) {
    if (!supported || !Array.isArray(supported)) {
      report.unsupported.push(name);
      continue;
    }
    if (!supported.includes(value as string)) {
      // Some cameras offer only "continuous"/"single-shot". "single-shot" still
      // beats continuous: it stops the hunt after one converge.
      const fallback = supported.includes("single-shot") ? "single-shot" : null;
      if (!fallback) {
        report.unsupported.push(`${name} (offers: ${supported.join("/")})`);
        continue;
      }
      report.requested.push(`${name}=${fallback}`);
      try {
        await track.applyConstraints({ advanced: [{ [name]: fallback }] } as MediaTrackConstraints);
        report.applied.push(`${name}=${fallback}`);
      } catch {
        report.refused.push(`${name}=${fallback}`);
      }
      continue;
    }
    report.requested.push(`${name}=${value}`);
    try {
      await track.applyConstraints({ advanced: [{ [name]: value }] } as MediaTrackConstraints);
      report.applied.push(`${name}=${value}`);
    } catch {
      report.refused.push(`${name}=${value}`);
    }
  }

  report.settings = (track.getSettings?.() ?? {}) as Record<string, unknown>;

  if (report.applied.length === 0) {
    report.note =
      "This camera exposes no manual controls. It will keep hunting focus and exposure against the flashing grid — expect more dropped frames. Steady the device and keep the light constant.";
  } else if (report.unsupported.length || report.refused.length) {
    report.note = "Partially locked. The rest stay automatic and will hunt.";
  } else {
    report.note = "Focus, exposure and white balance are pinned.";
  }
  return report;
}
