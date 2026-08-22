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
        <h1>lightpipe</h1>
        <span className="sub">a file, moved with nothing but light</span>
        <span className={`impl-badge ${optical.implementation}`}>
          {optical.implementation === "mock" ? "mock core" : "wasm core"}
        </span>
      </header>

      {optical.implementation === "mock" && (
        <div className="notice warn" style={{ marginTop: 14 }}>
          <strong>Running against the test double, not the real core.</strong>
          <span className="small">
            A stand-in engine is loaded instead of the real one. It is a genuine optical link —
            real colour grid, checksummed frames, out-of-order reassembly — but it uses simpler
            error coding and skips the alignment maths. Speeds and frame counts shown here are
            its own, not the project's measured figures.
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
            canvas through a shrink-and-blur stage that imitates a camera, so the whole path —
            frames, unreadable frames, pieces completing, writing to disk, the final code
            comparison — runs for real.
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
        No network, no Bluetooth, no NFC, no pairing, no cable — at any point. The sending screen
        never learns whether anyone is watching, so it broadcasts until a person stops it. Frames
        that cannot be read cost nothing; the picture repeats. A poor camera finishes slowly but
        it does finish — the measured floor is a weak hand-held webcam at 17.7 KB/s.
      </footer>
    </div>
  );
}
