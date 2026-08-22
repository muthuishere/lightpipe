import { useRef, useState } from "react";
import optical from "./optical";
import Sender from "./components/Sender";
import Receiver from "./components/Receiver";

type View = "send" | "receive" | "both";

export default function App() {
  const [view, setView] = useState<View>("send");
  const [sending, setSending] = useState(false);
  const senderCanvas = useRef<HTMLCanvasElement | null>(null);

  const show = (v: View) => ({
    display: view === v || view === "both" ? "block" : "none",
  });

  return (
    <div className="app">
      <header className="top">
        <h1>transfer-qr</h1>
        <span className="sub">a file, moved with nothing but light</span>
        <span className={`impl-badge ${optical.implementation}`}>
          {optical.implementation === "mock" ? "mock core" : "wasm core"}
        </span>
      </header>

      {optical.implementation === "mock" && (
        <div className="notice warn" style={{ marginTop: 14 }}>
          <strong>Running against the test double, not the real core.</strong>
          <span className="small">
            The mock is a real optical channel — P8 cell grid, CRC-guarded frames, out-of-order
            reassembly — but it has no RaptorQ (a round-robin repeater instead), no fiducial
            detection or homography, no gzip and no BLAKE3. Throughput and frame counts shown here
            are the mock's, not the measured numbers in <span className="mono">docs/spikes/LOG.md</span>.
          </span>
        </div>
      )}

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={view === "send"} onClick={() => setView("send")}>
          Send
        </button>
        <button role="tab" aria-selected={view === "receive"} onClick={() => setView("receive")}>
          Receive
        </button>
        <button role="tab" aria-selected={view === "both"} onClick={() => setView("both")}>
          Loopback demo
        </button>
      </nav>

      {view === "both" && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>Both halves, one tab, no hardware.</strong>
          <span className="small">
            Pick a file and start sending, then start receiving with source{" "}
            <span className="mono">Simulated loopback</span>. The receiver reads the sender's own
            canvas through a downscale-and-defocus stage, so the whole path — frames, erasures,
            chunk completion, OPFS writes, the final code comparison — runs for real.
          </span>
        </div>
      )}

      {/* Both stay mounted: the sender's rAF loop must keep running while you
          are looking at the receiver, otherwise loopback has nothing to read. */}
      <div style={show("send")}>
        <Sender
          canvasRef={senderCanvas}
          onSendingChange={setSending}
          active={view !== "receive"}
        />
      </div>
      <div style={show("receive")}>
        <Receiver senderCanvasRef={senderCanvas} senderActive={sending} />
      </div>

      <footer className="foot">
        No network, no Bluetooth, no NFC, no pairing, no cable — at any point. The sender never
        learns whether anyone is watching (ADR-0005), so it broadcasts forever and a human stops
        it. Frames that fail to decode are erasures, not errors (ADR-0004). A bad camera finishes
        slowly; it still finishes (ADR-0011) — the measured floor is a hand-held potato webcam at
        1,182 B/frame, 17.7 KB/s at 15 FPS.
      </footer>
    </div>
  );
}
