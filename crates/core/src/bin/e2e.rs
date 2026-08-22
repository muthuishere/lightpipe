//! End-to-end integration: the whole chain, in one pass, with nothing stubbed.
//!
//! ```text
//! file bytes
//!   -> chunk + gzip + manifest            (pipeline, ADR-0006)
//!   -> per-chunk RaptorQ packets          (fountain, ADR-0004)
//!   -> header record + CRC per frame      (header,   ADR-0004)
//!   -> render cells                       (modem,    ADR-0003)
//!   -> stamp fiducials                    (geometry, ADR-0002)
//!   == Channel::*_handheld() ==           (sim,      ADR-0009/0011)
//!   -> rectify via homography             (geometry)
//!   -> decode_frame, drop on bad CRC      (header)   <- erasures are normal
//!   -> fountain receiver, any order       (fountain)
//!   -> chunk completes, verify BLAKE3     (pipeline)
//!   -> write at chunk offset, out of order(pipeline, ADR-0008 model)
//!   -> whole-file BLAKE3 + display code
//! ```
//!
//! Every camera is a `*_handheld()` preset: base presets model the **sensor**, the
//! handheld variants add **pose** (ADR-0011's simulator contract). The layer used per
//! camera is the clean rung S4 measured in `artifacts/s4-frontier.csv`.
//!
//! Artifacts: `artifacts/e2e-report.txt`, `artifacts/e2e-waterfall.csv`.

use std::fmt::Write as _;
use std::time::Instant;

use optical_core::header::{self, DecodedFrame, FrameHeader};
use optical_core::pipeline::{
    ChunkFountain, Config, Encoder, Encoding, PacketCollector, PacketEmitter, RaptorqFountain,
    Receiver, ResumeCode, SparseSink,
};
use optical_core::sim::Channel;
use optical_core::{geometry, FrameSpec, Palette, RgbImage, P8};

const W: usize = 1920;
const H: usize = 1080;

/// FPS the throughput numbers are quoted at. Neither is measured — the optical
/// link runs at whatever rate the screen and camera agree on (S8 measures that on
/// real hardware). Everything here is `bytes / (frames / FPS)`.
const FPS: [f64; 2] = [15.0, 30.0];

// ---------------------------------------------------------------------------
// presets — the S4 clean rung per camera
// ---------------------------------------------------------------------------

struct Preset {
    name: &'static str,
    ch: Channel,
    pal: &'static Palette,
    cell: usize,
    /// Rolling-shutter tear on every Nth frame (0 = never). A torn frame carries
    /// rows from two different renders, which is exactly the erasure ADR-0004
    /// says is normal — and the only way this sweep sees a non-zero drop rate.
    tear_every: usize,
}

fn presets() -> Vec<Preset> {
    vec![
        Preset {
            name: "good_handheld",
            ch: Channel::good_handheld(),
            pal: &P8,
            cell: 8,
            tear_every: 0,
        },
        Preset {
            name: "webcam_handheld",
            ch: Channel::webcam_handheld(),
            pal: &P8,
            cell: 8,
            tear_every: 0,
        },
        Preset {
            name: "potato_handheld",
            ch: Channel::potato_handheld(),
            pal: &P8,
            cell: 20,
            tear_every: 0,
        },
    ]
}

/// The same webcam, but the screen refresh and the camera shutter are not
/// synchronised: every third capture is torn across the middle. Nothing else
/// in this sweep produces a dropped frame, so this is where the fountain layer
/// is actually load-bearing rather than decorative.
fn torn_webcam() -> Preset {
    Preset {
        name: "webcam+tear/3",
        ch: Channel::webcam_handheld(),
        pal: &P8,
        cell: 8,
        tear_every: 3,
    }
}

// ---------------------------------------------------------------------------
// corpora
// ---------------------------------------------------------------------------

/// Deterministic prose-ish corpus. A 256-word vocabulary drawn with a Zipf-ish
/// bias, plus 30% high-entropy identifier tokens — which lands the gzip ratio at
/// ~0.36, i.e. what S5 measured on a real prose corpus (0.354). A toy vocabulary
/// alone gzips to 0.22 and would flatter every efficiency number here.
fn text_corpus(n: usize) -> Vec<u8> {
    const STEMS: [&str; 16] = [
        "trans", "opt", "frag", "lumin", "cam", "sig", "chan", "grid", "phot", "vec", "modu",
        "quant", "rect", "verif", "pack", "strid",
    ];
    const TAILS: [&str; 16] = [
        "fer", "ical", "ment", "ance", "era", "nal", "nel", "ding", "onic", "tor", "lation",
        "ised", "ifier", "ation", "eting", "ent",
    ];
    const ALPHA: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let vocab: Vec<String> = (0..256)
        .map(|i: usize| format!("{}{}", STEMS[i % 16], TAILS[(i / 16) % 16]))
        .collect();
    let mut x: u32 = 0x1234_5678;
    let mut out = Vec::with_capacity(n + 32);
    let mut col = 0usize;
    while out.len() < n {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        let len_before = out.len();
        if x % 100 < 30 {
            for i in 0..7u32 {
                out.push(ALPHA[((x >> (3 * i)) % 36) as usize]);
            }
        } else {
            // Squaring a uniform draw biases toward the head of the list (Zipf-ish).
            let u = (x >> 8) as f64 / (1u32 << 24) as f64;
            out.extend_from_slice(vocab[((u * u * 256.0) as usize).min(255)].as_bytes());
        }
        col += out.len() - len_before + 1;
        if col > 72 {
            out.push(b'\n');
            col = 0;
        } else if x & 0x40 == 0 {
            out.extend_from_slice(b", ");
            col += 1;
        } else {
            out.push(b' ');
        }
    }
    out.truncate(n);
    out
}

/// Incompressible corpus — an mp4/jpg/zip stand-in. The probe sends it raw
/// (ADR-0006), so the gzip stage of the waterfall is exactly 1.00.
fn blob_corpus(n: usize) -> Vec<u8> {
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    (0..n)
        .map(|_| {
            x ^= x << 7;
            x ^= x >> 9;
            (x >> 24) as u8
        })
        .collect()
}

// ---------------------------------------------------------------------------
// one frame, all the way round
// ---------------------------------------------------------------------------

struct FrameOut {
    decoded: Option<DecodedFrame>,
    enc_ns: u128,
    chan_ns: u128,
    /// `detect_fiducials` + `fit_geometry`. Paid on every frame before ADR-0015,
    /// only on acquisition and on failure after it.
    fit_ns: u128,
    /// `warp_with` — the full-frame inverse warp.
    warp_ns: u128,
    hdr_ns: u128,
    /// The geometry this frame solved, to seed the next frame's cache (ADR-0015).
    fit: Option<geometry::GeometryFit>,
    /// The cached pose was not usable and the frame had to be re-fitted.
    refit: bool,
}

/// render -> fiducials -> channel -> rectify -> decode. The whole optical layer.
fn shoot(spec: &FrameSpec, pal: &Palette, ch: &Channel, seq: u32, packet: &[u8]) -> FrameOut {
    let t0 = Instant::now();
    let hdr = FrameHeader::new(seq, packet.len() as u16, [0u8; 12]);
    // `oti` is filled by the caller through `with_oti`; done here to keep one struct.
    let mut img = header::encode_frame(&hdr, packet, spec, pal).expect("packet fits the frame");
    geometry::stamp_fiducials(&mut img, spec);
    let t1 = Instant::now();
    let seen = ch.apply(&img);
    let t2 = Instant::now();
    let fit = geometry::fit_geometry(&seen, spec);
    let t3 = Instant::now();
    let rect = fit.map(|f| geometry::warp_with(&seen, spec, &f));
    let t4 = Instant::now();
    let decoded = rect
        .as_ref()
        .and_then(|r: &RgbImage| header::decode_frame(r, spec, pal));
    let t5 = Instant::now();
    FrameOut {
        decoded,
        enc_ns: (t1 - t0).as_nanos(),
        chan_ns: (t2 - t1).as_nanos(),
        fit_ns: (t3 - t2).as_nanos(),
        warp_ns: (t4 - t3).as_nanos(),
        hdr_ns: (t5 - t4).as_nanos(),
        fit,
        refit: false,
    }
}

/// Same, but with the OTI the fountain wants in the header record.
#[allow(clippy::too_many_arguments)]
fn shoot_with_oti(
    spec: &FrameSpec,
    pal: &Palette,
    ch: &Channel,
    seq: u32,
    oti: [u8; 12],
    packet: &[u8],
    tear: Option<(&[u8], f32)>,
    // `cached`: the pose solved on an earlier frame (ADR-0015). None = acquisition.
    cached: Option<geometry::GeometryFit>,
) -> FrameOut {
    let t0 = Instant::now();
    let hdr = FrameHeader::new(seq, packet.len() as u16, oti);
    let mut img = header::encode_frame(&hdr, packet, spec, pal).expect("packet fits the frame");
    geometry::stamp_fiducials(&mut img, spec);
    let prev = tear.map(|(p, _)| {
        let h = FrameHeader::new(seq, p.len() as u16, oti);
        let mut i = header::encode_frame(&h, p, spec, pal).expect("packet fits the frame");
        geometry::stamp_fiducials(&mut i, spec);
        i
    });
    let t1 = Instant::now();
    let seen = match (&prev, tear) {
        (Some(prev), Some((_, at))) => ch.with_tear(at).apply_pair(&img, prev),
        _ => ch.apply(&img),
    };
    let t2 = Instant::now();
    // Fitted on every frame so the pre-ADR-0015 cost stays measurable, even when
    // the decode itself runs off the cached pose.
    let fresh = geometry::fit_geometry(&seen, spec);
    let t3 = Instant::now();
    let mut warp_ns = 0u128;
    let mut hdr_ns = 0u128;
    let mut decoded = None;
    let mut attempt = |fit: geometry::GeometryFit| {
        let a = Instant::now();
        let rect = geometry::warp_with(&seen, spec, &fit);
        let b = Instant::now();
        let out = header::decode_frame(&rect, spec, pal);
        hdr_ns += b.elapsed().as_nanos();
        warp_ns += (b - a).as_nanos();
        out
    };
    // ADR-0015: try the cached pose first; fall back to the fresh fit only if it
    // fails, which is what makes a re-fit the exception rather than the rule.
    if let Some(fit) = cached {
        decoded = attempt(fit);
    }
    let refit = cached.is_some() && decoded.is_none();
    if decoded.is_none() {
        if let Some(fit) = fresh {
            decoded = attempt(fit);
        }
    }
    FrameOut {
        decoded,
        enc_ns: (t1 - t0).as_nanos(),
        chan_ns: (t2 - t1).as_nanos(),
        fit_ns: (t3 - t2).as_nanos(),
        warp_ns,
        hdr_ns,
        fit: fresh,
        refit,
    }
}

/// Frames are independent, so the optical layer parallelises trivially. Only the
/// wall clock changes; every CPU number reported is the summed single-thread cost.
fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(items.len().max(1));
    if threads <= 1 {
        return items.iter().map(&f).collect();
    }
    let per = items.len().div_ceil(threads);
    let mut parts: Vec<Vec<R>> = Vec::new();
    std::thread::scope(|s| {
        let mut handles = Vec::new();
        let fr = &f;
        for stripe in items.chunks(per) {
            handles.push(s.spawn(move || stripe.iter().map(fr).collect::<Vec<_>>()));
        }
        for h in handles {
            parts.push(h.join().expect("worker panicked"));
        }
    });
    parts.into_iter().flatten().collect()
}

type Job = (u32, Vec<u8>, Option<(Vec<u8>, f32)>);

#[allow(clippy::too_many_arguments)]
fn par_shoot(
    spec: &FrameSpec,
    pal: &Palette,
    ch: &Channel,
    oti: [u8; 12],
    jobs: &[Job],
    cached: Option<geometry::GeometryFit>,
) -> Vec<FrameOut> {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(jobs.len().max(1));
    if threads <= 1 {
        return jobs
            .iter()
            .map(|(s, p, t)| {
                shoot_with_oti(
                    spec,
                    pal,
                    ch,
                    *s,
                    oti,
                    p,
                    t.as_ref().map(|(v, a)| (&v[..], *a)),
                    cached,
                )
            })
            .collect();
    }
    let per = jobs.len().div_ceil(threads);
    let mut out: Vec<FrameOut> = Vec::with_capacity(jobs.len());
    let mut parts: Vec<Vec<FrameOut>> = Vec::new();
    std::thread::scope(|s| {
        let mut handles = Vec::new();
        for stripe in jobs.chunks(per) {
            handles.push(s.spawn(move || {
                stripe
                    .iter()
                    .map(|(seq, packet, tear)| {
                        shoot_with_oti(
                            spec,
                            pal,
                            ch,
                            *seq,
                            oti,
                            packet,
                            tear.as_ref().map(|(v, a)| (&v[..], *a)),
                            cached,
                        )
                    })
                    .collect::<Vec<_>>()
            }));
        }
        for h in handles {
            parts.push(h.join().expect("worker panicked"));
        }
    });
    for part in parts {
        out.extend(part);
    }
    out
}

// ---------------------------------------------------------------------------
// a whole transfer
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct Cost {
    enc_ns: u128,
    chan_ns: u128,
    /// Geometry fit on every frame — the pre-ADR-0015 decode path.
    fit_ns: u128,
    /// Geometry fit actually charged under ADR-0015: acquisition plus re-fits.
    fit_charged_ns: u128,
    warp_ns: u128,
    hdr_ns: u128,
    fountain_ns: u128,
    chunk_verify_ns: u128,
    refits: usize,
    acquisitions: usize,
}

struct Run {
    frames_emitted: usize,
    frames_decoded: usize,
    k_total: usize,
    packets_used: usize,
    stored_bytes: u64,
    delivered_bytes: u64,
    chunks_done: usize,
    reverified_chunks: usize,
    chunk_count: usize,
    capacity: usize,
    symbol_size: usize,
    encoding: Encoding,
    cost: Cost,
    needed_trace: Vec<u32>,
    ok_hash: bool,
    sender_code: String,
    receiver_code: String,
    resume_code: Option<ResumeCode>,
    sink: SparseSink,
}

#[derive(Default)]
struct Opts {
    /// Stop after this many chunks have landed (the "killed mid-transfer" case).
    stop_after: Option<usize>,
    /// Chunks to actually send, in this order. `None` = all, in a shuffled order.
    only: Option<Vec<usize>>,
    /// Pre-existing partially-written sink to continue into.
    sink: Option<SparseSink>,
    /// Continue a killed transfer from the code the human typed. Retained chunks
    /// are re-verified off the sink; only what is still missing is re-sent.
    resume_from: Option<ResumeCode>,
    trace_needed: bool,
}

/// Deterministic "out of order": a fixed odd stride over the chunk list, so chunks
/// land at their byte offsets in a scrambled sequence (ADR-0008's model).
fn scrambled(n: usize) -> Vec<usize> {
    if n <= 2 {
        return (0..n).collect();
    }
    let stride = (n / 3).max(1) * 2 + 1;
    let mut seen = vec![false; n];
    let mut out = Vec::with_capacity(n);
    let mut i = 0usize;
    while out.len() < n {
        if !seen[i] {
            seen[i] = true;
            out.push(i);
        } else {
            i = (i + 1) % n;
            continue;
        }
        i = (i + stride) % n;
    }
    out
}

fn run_transfer(p: &Preset, data: &[u8], opts: Opts) -> Run {
    let spec = geometry::frame_spec(W, H, p.cell);
    let capacity = spec.capacity_bytes(p.pal);
    let fountain = RaptorqFountain::new(capacity);
    let mut cost = Cost::default();

    let mut enc = Encoder::build(data, Config::default());
    let manifest = enc.manifest().clone();
    let chunk_count = manifest.chunk_count as usize;

    let sink = opts.sink.unwrap_or_default();
    let (mut rx, reverified) = match opts.resume_from {
        Some(code) => Receiver::resume(manifest.clone(), sink, &code).expect("resume"),
        None => (Receiver::new(manifest.clone(), sink), 0),
    };

    let order = opts.only.clone().unwrap_or_else(|| match opts.resume_from {
        Some(_) => rx.missing(),
        None => scrambled(chunk_count),
    });

    let mut cache: Option<geometry::GeometryFit> = None;
    let mut frames_emitted = 0usize;
    let mut frames_decoded = 0usize;
    let mut k_total = 0usize;
    let mut packets_used = 0usize;
    let mut stored_bytes = 0u64;
    let mut needed_trace = Vec::new();
    let mut chunks_done = 0usize;
    let reverified_chunks = reverified;
    let mut resume_code = None;

    'chunks: for &ci in &order {
        let payload = enc.chunk_payload(ci).expect("chunk exists");
        stored_bytes += payload.len() as u64;
        let mut tx = fountain.emitter(&payload);
        let oti = tx.oti();
        let k = tx.source_symbols();
        k_total += k;

        // The receiver learns everything about this chunk from the frame header:
        // `seq` names the chunk, `oti` sizes the fountain. Nothing is assumed.
        let mut collector: Option<<RaptorqFountain as ChunkFountain>::Collector> = None;
        let mut want = k; // first batch: the theoretical minimum
        let mut sent = 0usize;
        let mut last: Vec<u8> = vec![0u8; capacity];
        let mut done = false;

        while !done {
            // Acquisition is one frame, not a whole batch: otherwise every frame of
            // the first batch pays a full fit in parallel and the cache never helps.
            let batch = if cache.is_none() { 1 } else { want };
            let jobs: Vec<Job> = (0..batch)
                .map(|_| {
                    let packet = tx.next_packet();
                    sent += 1;
                    let tear = if p.tear_every > 0 && sent.is_multiple_of(p.tear_every) {
                        // Seam height walks the frame, as an unsynchronised shutter does.
                        Some((last.clone(), 0.25 + 0.5 * ((sent % 5) as f32 / 5.0)))
                    } else {
                        None
                    };
                    last = packet.clone();
                    (ci as u32, packet, tear)
                })
                .collect();
            let outs = par_shoot(&spec, p.pal, &p.ch, oti, &jobs, cache);
            for out in outs {
                frames_emitted += 1;
                cost.enc_ns += out.enc_ns;
                cost.chan_ns += out.chan_ns;
                cost.fit_ns += out.fit_ns;
                cost.warp_ns += out.warp_ns;
                cost.hdr_ns += out.hdr_ns;
                // ADR-0015: the fit is charged on acquisition and on a re-fit only.
                if cache.is_none() {
                    cost.fit_charged_ns += out.fit_ns;
                    cost.acquisitions += 1;
                } else if out.refit {
                    cost.fit_charged_ns += out.fit_ns;
                    cost.refits += 1;
                }
                if cache.is_none() {
                    cache = out.fit;
                }
                let Some(df) = out.decoded else { continue };
                frames_decoded += 1;
                let col = collector.get_or_insert_with(|| {
                    fountain
                        .collector_from_oti(df.header.oti)
                        .expect("header carried a decodable OTI")
                });
                let t = Instant::now();
                let got = col.absorb(&df.payload);
                cost.fountain_ns += t.elapsed().as_nanos();
                packets_used += 1;
                if opts.trace_needed {
                    needed_trace.push(col.needed());
                }
                if let Some(stored) = got {
                    let t = Instant::now();
                    rx.accept(ci, &stored).expect("chunk verifies");
                    cost.chunk_verify_ns += t.elapsed().as_nanos();
                    chunks_done += 1;
                    done = true;
                    break;
                }
            }
            if !done {
                let need = collector.as_ref().map(|c| c.needed()).unwrap_or(k as u32);
                want = (need as usize).clamp(1, 64);
            }
            if opts.stop_after.is_some_and(|limit| chunks_done >= limit) {
                break 'chunks;
            }
        }
    }

    // A transfer does not die tidily on a chunk boundary. Push part of the next
    // chunk into the receiver and read the code off the screen mid-chunk, which is
    // what the human of ADR-0005 actually sees: "chunk N, need M".
    if opts.stop_after.is_some() {
        let need = match rx.first_missing() {
            Some(ci) => {
                let payload = enc.chunk_payload(ci).expect("chunk exists");
                let mut tx = fountain.emitter(&payload);
                let oti = tx.oti();
                let k = tx.source_symbols();
                let partial = (k * 2 / 5).max(1);
                let jobs: Vec<Job> = (0..partial)
                    .map(|_| (ci as u32, tx.next_packet(), None))
                    .collect();
                let mut col = fountain
                    .collector_from_oti(oti)
                    .expect("locally built OTI is well formed");
                for out in par_shoot(&spec, p.pal, &p.ch, oti, &jobs, cache) {
                    frames_emitted += 1;
                    cost.enc_ns += out.enc_ns;
                    cost.chan_ns += out.chan_ns;
                    cost.fit_ns += out.fit_ns;
                    cost.warp_ns += out.warp_ns;
                    cost.hdr_ns += out.hdr_ns;
                    if cache.is_none() {
                        cost.fit_charged_ns += out.fit_ns;
                        cost.acquisitions += 1;
                        cache = out.fit;
                    } else if out.refit {
                        cost.fit_charged_ns += out.fit_ns;
                        cost.refits += 1;
                    }
                    if let Some(df) = out.decoded {
                        frames_decoded += 1;
                        col.absorb(&df.payload);
                    }
                }
                col.needed()
            }
            None => 0,
        };
        resume_code = Some(rx.resume_code(need));
    }

    let delivered_bytes = rx.bytes_written();
    let ok_hash = rx.is_complete() && rx.verify_file().is_ok();
    let receiver_code = if rx.is_complete() {
        optical_core::pipeline::display_code(&rx.verify_file().unwrap_or([0u8; 32]))
    } else {
        String::from("(incomplete)")
    };

    Run {
        frames_emitted,
        frames_decoded,
        k_total,
        packets_used,
        stored_bytes,
        delivered_bytes,
        chunks_done,
        reverified_chunks,
        chunk_count,
        capacity,
        symbol_size: fountain.symbol_size(),
        encoding: manifest.encoding,
        cost,
        needed_trace,
        ok_hash,
        sender_code: manifest.display_code(),
        receiver_code,
        resume_code,
        sink: rx.into_sink(),
    }
}

// ---------------------------------------------------------------------------
// the waterfall
// ---------------------------------------------------------------------------

struct Stage {
    label: &'static str,
    /// Bytes per **emitted frame** still standing after this stage.
    value: f64,
}

/// Every cost in the stack, in one unit: bytes of delivered file per frame the
/// screen actually showed. Each row is what the previous row lost.
fn waterfall(p: &Preset, run: &Run) -> Vec<Stage> {
    let spec = geometry::frame_spec(W, H, p.cell);
    let bits = p.pal.bits as f64;
    let cells_possible = ((W / p.cell) * (H / p.cell)) as f64;
    let grid_cells = (spec.cols() * spec.rows()) as f64;
    let after_calib = ((spec.rows() - FrameSpec::CALIB_ROWS) * spec.cols()) as f64;
    let payload_cells = spec.payload_cells() as f64;
    let emitted = run.frames_emitted as f64;
    let decoded_frac = run.frames_decoded as f64 / emitted;
    let use_frac = run.k_total as f64 / run.packets_used.max(1) as f64;
    let padded = (run.k_total * run.symbol_size) as f64;
    let stored = run.stored_bytes as f64;

    let raw = cells_possible * bits / 8.0;
    let s_margin = grid_cells * bits / 8.0;
    let s_calib = after_calib * bits / 8.0;
    let s_header = payload_cells * bits / 8.0;
    let s_pack = run.capacity as f64;
    let s_crc = s_pack * decoded_frac;
    let s_fecid = run.symbol_size as f64 * decoded_frac;
    let s_surplus = s_fecid * use_frac;
    let s_padding = s_surplus * (stored / padded);
    let s_final = run.delivered_bytes as f64 / emitted;

    vec![
        Stage {
            label: "raw cell bits on screen",
            value: raw,
        },
        Stage {
            label: "- fiducials + margin",
            value: s_margin,
        },
        Stage {
            label: "- calibration strip",
            value: s_calib,
        },
        Stage {
            label: "- header band",
            value: s_header,
        },
        Stage {
            label: "- bit-packing remainder",
            value: s_pack,
        },
        Stage {
            label: "- frames dropped on CRC",
            value: s_crc,
        },
        Stage {
            label: "- RaptorQ FEC payload id",
            value: s_fecid,
        },
        Stage {
            label: "- fountain surplus packets",
            value: s_surplus,
        },
        Stage {
            label: "- symbol padding",
            value: s_padding,
        },
        Stage {
            label: "+ gzip gain -> file bytes",
            value: s_final,
        },
    ]
}

// ---------------------------------------------------------------------------
// layered broadcast (ADR-0011) — does one stream really serve both cameras?
// ---------------------------------------------------------------------------

/// ADR-0011 interleaves several profiles into one broadcast and has every
/// receiver "harvest blocks from whichever layers it can decode". That only works
/// if the layers share a **symbol size**: RaptorQ symbols of different sizes belong
/// to different source blocks and cannot be pooled into one decoder.
///
/// So this runs the ladder with ONE symbol size — the coarse rung's 1,178 B — and
/// packs as many packets into a dense frame as fit. Both cameras then decode the
/// same broadcast, and the good one is not paying for the coarse frames it sees.
fn layered_demo(r: &mut Report, quick: bool) {
    let coarse = geometry::frame_spec(W, H, 20);
    let dense = geometry::frame_spec(W, H, 8);
    let pal = &P8;
    let sym_cap = coarse.capacity_bytes(pal); // one packet per coarse frame
    let per_dense = dense.capacity_bytes(pal) / sym_cap;
    let chunk = blob_corpus(if quick { 16 * 1024 } else { 64 * 1024 });

    let fountain = RaptorqFountain::new(sym_cap);
    let mut tx = fountain.emitter(&chunk);
    let oti = tx.oti();
    let k = tx.source_symbols();

    r.line("LAYERED BROADCAST — ONE STREAM, BOTH CAMERAS (ADR-0011, ADR-0012)");
    r.line("-----------------------------------------------------------------");
    r.line(format!(
        "  chunk {} B, symbol {} B (the coarse rung), K = {k} packets.",
        chunk.len(),
        sym_cap - 4
    ));
    r.line(format!(
        "  coarse frame (P8@20px) carries 1 packet = {} B; dense frame (P8@8px) carries",
        sym_cap
    ));
    r.line(format!(
        "  {per_dense} packets = {} of {} B ({:.1}% — the granularity cost of a shared symbol size).",
        per_dense * sym_cap,
        dense.capacity_bytes(pal),
        100.0 * (per_dense * sym_cap) as f64 / dense.capacity_bytes(pal) as f64
    ));

    // One broadcast: every 4th frame is coarse, the rest dense. Enough coarse
    // frames that a camera which can read *only* the coarse layer still finishes.
    let mut stream: Vec<(bool, Vec<u8>)> = Vec::new(); // (is_dense, payload)
    let mut coarse_frames = 0usize;
    while coarse_frames < k {
        for i in 0..4 {
            if i == 0 {
                stream.push((false, tx.next_packet()));
                coarse_frames += 1;
            } else {
                let mut buf = Vec::with_capacity(per_dense * sym_cap);
                for _ in 0..per_dense {
                    buf.extend_from_slice(&tx.next_packet());
                }
                stream.push((true, buf));
            }
        }
    }

    r.line("");
    r.line(format!(
        "  {:<18}{:>9}{:>10}{:>12}{:>12}{:>10}",
        "camera", "frames", "coarse", "dense used", "packets", "B/frame"
    ));
    for (name, ch) in [
        ("good_handheld", Channel::good_handheld()),
        ("potato_handheld", Channel::potato_handheld()),
    ] {
        let mut col = fountain
            .collector_from_oti(oti)
            .expect("oti round-trips through the header");
        let mut frames = 0usize;
        let mut used_coarse = 0usize;
        let mut used_dense = 0usize;
        let mut done = None;
        // Frames are independent up to the point the chunk completes, so shoot
        // them in blocks and stop at the first block that finishes it.
        let block = 16;
        'outer: for group in stream.chunks(block) {
            // Rendered at its own layer's geometry; the receiver does not know
            // which that was, so it tries both and lets the CRC decide
            // (ADR-0011: "one decoder per layer geometry").
            let shot = par_map(group, |(is_dense, payload)| {
                let spec = if *is_dense { &dense } else { &coarse };
                let hdr = FrameHeader::new(*is_dense as u32, payload.len() as u16, oti);
                let mut img =
                    header::encode_frame(&hdr, payload, spec, pal).expect("packet fits the frame");
                geometry::stamp_fiducials(&mut img, spec);
                let seen = ch.apply(&img);
                [&dense, &coarse].into_iter().find_map(|try_spec| {
                    geometry::rectify(&seen, try_spec)
                        .and_then(|r| header::decode_frame(&r, try_spec, pal))
                })
            });
            for (i, got) in shot.into_iter().enumerate() {
                frames += 1;
                let Some(df) = got else { continue };
                if group[i].0 {
                    used_dense += 1;
                } else {
                    used_coarse += 1;
                }
                for packet in df.payload.chunks(sym_cap) {
                    if let Some(out) = col.absorb(packet) {
                        done = Some(out);
                        break 'outer;
                    }
                }
            }
        }
        let out = done.expect("chunk must complete on both cameras");
        assert_eq!(out, chunk, "{name} rebuilt the chunk");
        r.line(format!(
            "  {:<18}{:>9}{:>10}{:>12}{:>12}{:>10.0}",
            name,
            frames,
            used_coarse,
            used_dense,
            used_coarse + used_dense * per_dense,
            chunk.len() as f64 / frames as f64
        ));
    }
    r.line("");
    r.line("  Both cameras finish off ONE broadcast, and the good camera's coarse frames are");
    r.line("  not wasted airtime — they carry packets of the same source block. With a");
    r.line("  per-layer symbol size (what ADR-0011 implies) they would have been unusable.");
    r.line("");
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

struct Report {
    buf: String,
}

impl Report {
    fn new() -> Self {
        Self { buf: String::new() }
    }
    fn line(&mut self, s: impl AsRef<str>) {
        let s = s.as_ref();
        println!("{s}");
        let _ = writeln!(self.buf, "{s}");
    }
}

fn kbs(bytes: u64, frames: usize, fps: f64) -> f64 {
    bytes as f64 / (frames as f64 / fps) / 1000.0
}

fn ms(ns: u128) -> f64 {
    ns as f64 / 1e6
}

// ---------------------------------------------------------------------------

fn main() {
    let _ = std::fs::create_dir_all("artifacts");
    let mut r = Report::new();
    let mut csv = String::from(
        "camera,payload,payload_bytes,stage,bytes_per_frame,stage_factor,cumulative_efficiency\n",
    );

    r.line("lightpipe — END-TO-END INTEGRATION (S0..S5 in one pass)");
    r.line("=========================================================");
    r.line("");
    r.line("Chain: file -> chunk+gzip+manifest -> RaptorQ -> header+CRC -> cells ->");
    r.line("       fiducials -> [ Channel::*_handheld() ] -> rectify -> CRC -> fountain");
    r.line("       -> BLAKE3 per chunk -> write at offset -> whole-file BLAKE3.");
    r.line("Nothing is stubbed: the fountain is raptorq (ADR-0004), not the S5 repeater.");
    r.line("");
    r.line("Layers are the clean rungs S4 measured (artifacts/s4-frontier.csv):");
    for p in presets() {
        let spec = geometry::frame_spec(W, H, p.cell);
        r.line(format!(
            "  {:<16} {} @ {:>2}px   capacity {:>6} B/frame   grid {}x{}",
            p.name,
            p.pal.name,
            p.cell,
            spec.capacity_bytes(p.pal),
            spec.cols(),
            spec.rows()
        ));
    }
    r.line("");

    // ------------------------------------------------------------- main sweep
    // `E2E_QUICK=1` shrinks every payload ~16x. Same code path, same tables, a
    // fraction of the runtime — for iterating without waiting on the full sweep.
    let quick = std::env::var("E2E_QUICK").is_ok();
    let big_bytes = if quick { 512 << 10 } else { 8 << 20 };
    let small_bytes = if quick { 128 << 10 } else { 1 << 20 };
    let corpora: Vec<(String, Vec<u8>)> = vec![
        (
            format!("text-{}KB", small_bytes >> 10),
            text_corpus(small_bytes),
        ),
        (
            format!("blob-{}KB", small_bytes >> 10),
            blob_corpus(small_bytes),
        ),
        (
            format!("text-{}KB", big_bytes >> 10),
            text_corpus(big_bytes),
        ),
    ];

    r.line("REAL END-TO-END THROUGHPUT");
    r.line("--------------------------");
    r.line("KB/s is delivered file bytes / (frames emitted / FPS). FPS is ASSUMED —");
    r.line("nothing here measures a screen or a camera. `cpu KB/s` is a different number:");
    r.line("delivered bytes / summed single-thread CPU on each side, all in KB/s.");
    r.line("");
    r.line("  cpu dec(refit)  — re-solving the geometry on EVERY frame. This is the");
    r.line("                    pre-ADR-0015 path and is NOT the decoder's real cost.");
    r.line("  cpu dec(cached) — ADR-0015: fit once, reuse the pose, re-fit only when a");
    r.line("                    frame fails. Still warps the whole frame (ADR-0015's");
    r.line("                    sample-point warp is not implemented here), and the");
    r.line("                    simulator holds the pose perfectly still, so it is an");
    r.line("                    upper bound on cache hit rate — a real hand moves.");
    r.line("");
    r.line(format!(
        "  {:<16}{:<12}{:>8}{:>7}{:>9}{:>9}{:>7}{:>10}{:>12}{:>12}",
        "camera",
        "payload",
        "frames",
        "drop%",
        "KB/s@15",
        "KB/s@30",
        "wire%",
        "cpu enc",
        "cpu dec(refit)",
        "cpu dec(cached)"
    ));

    let mut runs: Vec<(String, String, Run)> = Vec::new();
    for (cname, corpus) in &corpora {
        let mut cams = presets();
        // The torn camera is the only one that drops frames, so it runs on the
        // small payloads where its extra cost is affordable.
        if corpus.len() <= small_bytes {
            cams.push(torn_webcam());
        }
        for p in cams {
            let run = run_transfer(
                &p,
                corpus,
                Opts {
                    trace_needed: false,
                    ..Default::default()
                },
            );
            let drop = 100.0 * (1.0 - run.frames_decoded as f64 / run.frames_emitted as f64);
            let enc_kbs = run.delivered_bytes as f64 / (run.cost.enc_ns as f64 / 1e9) / 1000.0;
            let tail_ns = run.cost.warp_ns
                + run.cost.hdr_ns
                + run.cost.fountain_ns
                + run.cost.chunk_verify_ns;
            let dec_kbs =
                run.delivered_bytes as f64 / ((run.cost.fit_ns + tail_ns) as f64 / 1e9) / 1000.0;
            let dec_cached_kbs = run.delivered_bytes as f64
                / ((run.cost.fit_charged_ns + tail_ns) as f64 / 1e9)
                / 1000.0;
            assert!(
                run.ok_hash,
                "{} / {} failed whole-file BLAKE3",
                p.name, cname
            );
            r.line(format!(
                "  {:<16}{:<12}{:>8}{:>7.2}{:>9.1}{:>9.1}{:>7.1}{:>10.0}{:>12.0}{:>12.0}",
                p.name,
                cname,
                run.frames_emitted,
                drop,
                kbs(run.delivered_bytes, run.frames_emitted, FPS[0]),
                kbs(run.delivered_bytes, run.frames_emitted, FPS[1]),
                100.0 * run.stored_bytes as f64 / run.delivered_bytes as f64,
                enc_kbs,
                dec_kbs,
                dec_cached_kbs,
            ));
            runs.push((p.name.to_string(), cname.to_string(), run));
        }
    }
    r.line("");

    // ------------------------------------------------------------- waterfall
    r.line("EFFICIENCY WATERFALL — of the cell bits the screen emits, what arrives?");
    r.line("-----------------------------------------------------------------------");
    r.line("Unit: bytes of delivered file per frame actually displayed.");
    r.line("");
    for (cam, corpus, run) in &runs {
        let p = presets()
            .into_iter()
            .chain(std::iter::once(torn_webcam()))
            .find(|p| p.name == cam)
            .expect("preset exists");
        let stages = waterfall(&p, run);
        let raw = stages[0].value;
        r.line(format!(
            "  {cam} / {corpus}  ({} chunks, {} frames, encoding {})",
            run.chunk_count,
            run.frames_emitted,
            run.encoding.as_str()
        ));
        r.line(format!(
            "    {:<32}{:>12}{:>10}{:>12}",
            "stage", "B/frame", "step", "cumulative"
        ));
        let mut prev = raw;
        for (i, st) in stages.iter().enumerate() {
            let factor = if i == 0 { 1.0 } else { st.value / prev };
            r.line(format!(
                "    {:<32}{:>12.1}{:>9.1}%{:>11.2}%",
                st.label,
                st.value,
                100.0 * (factor - 1.0),
                100.0 * st.value / raw
            ));
            let _ = writeln!(
                csv,
                "{cam},{corpus},{},{},{:.3},{:.6},{:.6}",
                run.delivered_bytes,
                st.label.trim_start_matches(['-', '+', ' ']),
                st.value,
                factor,
                st.value / raw
            );
            prev = st.value;
        }
        r.line("");
    }

    r.line("  Read the waterfall as: 100% of the light the screen spends, minus each layer's");
    r.line("  cut, is what lands in the file. The last row is a *gain*: gzip delivers more");
    r.line("  file bytes than the wire carried, so file efficiency can exceed 100%.");
    r.line("");
    r.line(format!(
        "  {:<16}{:<12}{:>13}{:>13}{:>13}{:>12}{:>12}",
        "camera", "payload", "raw B/frame", "wire B/fr", "file B/fr", "wire eff", "file eff"
    ));
    for (cam, corpus, run) in &runs {
        let p = presets()
            .into_iter()
            .chain(std::iter::once(torn_webcam()))
            .find(|p| p.name == cam)
            .expect("preset exists");
        let st = waterfall(&p, run);
        let raw = st[0].value;
        let wire = st[st.len() - 2].value;
        let file = st[st.len() - 1].value;
        r.line(format!(
            "  {:<16}{:<12}{:>13.0}{:>13.1}{:>13.1}{:>11.2}%{:>11.2}%",
            cam,
            corpus,
            raw,
            wire,
            file,
            100.0 * wire / raw,
            100.0 * file / raw
        ));
    }
    r.line("");

    // --------------------------------------------------- CPU split of decoding
    r.line("CPU TIME — where it goes (summed single-thread, release build)");
    r.line("--------------------------------------------------------------");
    r.line(format!(
        "  {:<16}{:<12}{:>10}{:>11}{:>10}{:>12}{:>10}{:>9}{:>10}{:>9}",
        "camera",
        "payload",
        "encode ms",
        "channel ms",
        "fit ms",
        "fit chg ms",
        "warp ms",
        "decode ms",
        "fountain ms",
        "verify ms"
    ));
    for (cam, corpus, run) in &runs {
        r.line(format!(
            "  {:<16}{:<12}{:>10.0}{:>11.0}{:>10.0}{:>12.0}{:>10.0}{:>9.1}{:>10.1}{:>9.1}",
            cam,
            corpus,
            ms(run.cost.enc_ns),
            ms(run.cost.chan_ns),
            ms(run.cost.fit_ns),
            ms(run.cost.fit_charged_ns),
            ms(run.cost.warp_ns),
            ms(run.cost.hdr_ns),
            ms(run.cost.fountain_ns),
            ms(run.cost.chunk_verify_ns),
        ));
    }
    r.line("");
    r.line("  `channel ms` is the simulator standing in for air+sensor. It is NOT a cost");
    r.line("  either device pays in production; it is excluded from cpu KB/s above.");
    r.line("  `encode ms` is the per-frame sender cost (render + fiducials) only. Chunking,");
    r.line("  gzip and the manifest hashes happen once, outside the frame loop — S5 measured");
    r.line("  the compressor at 81.2 MB/s, ~600x the fastest channel here (ADR-0014).");
    r.line("  `fit ms` is every-frame geometry; `fit chg ms` is what ADR-0015 actually pays");
    r.line("  (acquisition + re-fits). `decode ms` is `header::decode_frame` — CRC, symbol");
    r.line("  sampling, bit unpacking — the only part that is really \"decoding\".");
    r.line("");

    // ------------------------------------------------------- geometry cache
    r.line("GEOMETRY CACHE (ADR-0015) — how often the pose had to be re-solved");
    r.line("------------------------------------------------------------------");
    r.line(format!(
        "  {:<16}{:<12}{:>9}{:>14}{:>9}{:>16}{:>16}",
        "camera", "payload", "frames", "acquisitions", "refits", "fit/frame ms", "warp/frame ms"
    ));
    for (cam, corpus, run) in &runs {
        r.line(format!(
            "  {:<16}{:<12}{:>9}{:>14}{:>9}{:>16.1}{:>16.1}",
            cam,
            corpus,
            run.frames_emitted,
            run.cost.acquisitions,
            run.cost.refits,
            ms(run.cost.fit_ns) / run.frames_emitted as f64,
            ms(run.cost.warp_ns) / run.frames_emitted as f64,
        ));
    }
    r.line("");
    r.line("  A re-fit happens only where a frame failed to decode off the cached pose —");
    r.line("  which in this simulator is exactly the frames the tear destroyed. The pose is");
    r.line("  static here; a moving hand would re-fit more often.");
    r.line("");

    // ------------------------------------------------- fountain / frame budget
    r.line("FOUNTAIN + FRAME BUDGET");
    r.line("-----------------------");
    r.line(format!(
        "  {:<16}{:<12}{:>8}{:>9}{:>10}{:>9}{:>13}",
        "camera", "payload", "K", "packets", "overhead", "frames", "B/frame net"
    ));
    for (cam, corpus, run) in &runs {
        r.line(format!(
            "  {:<16}{:<12}{:>8}{:>9}{:>9.3}%{:>9}{:>13.1}",
            cam,
            corpus,
            run.k_total,
            run.packets_used,
            100.0 * (run.packets_used as f64 / run.k_total as f64 - 1.0),
            run.frames_emitted,
            run.delivered_bytes as f64 / run.frames_emitted as f64,
        ));
    }
    r.line("");

    layered_demo(&mut r, quick);

    // ------------------------------------------------- human-facing guarantees
    r.line("HUMAN-FACING GUARANTEES (ADR-0005 / ADR-0011)");
    r.line("---------------------------------------------");

    // 1. display codes
    let (_, _, sample) = runs
        .iter()
        .find(|(c, n, _)| c == "webcam_handheld" && n.starts_with("text-"))
        .expect("run exists");
    r.line(format!(
        "  1. display code   sender {} == receiver {}   -> {}",
        sample.sender_code,
        sample.receiver_code,
        if sample.sender_code == sample.receiver_code {
            "MATCH"
        } else {
            "MISMATCH"
        }
    ));
    assert_eq!(sample.sender_code, sample.receiver_code);

    // 2. needed_more() countdown
    // The potato is the interesting case: its layer is 1,182 B/frame, so one
    // 256 KB chunk is K = 223 frames and the countdown is a three-digit number —
    // exactly the "need 340 more" of the README.
    let traced = run_transfer(
        &presets().remove(2),
        &blob_corpus(if quick { 64 * 1024 } else { 250 * 1024 }),
        Opts {
            trace_needed: true,
            ..Default::default()
        },
    );
    let t = &traced.needed_trace;
    let max = t.iter().copied().max().unwrap_or(0);
    let monotone = t.windows(2).all(|w| w[1] <= w[0] || w[1] == 0);
    r.line(format!(
        "  2. needed_more()  starts at {max}, ends at {}, {} readings, monotone={}",
        t.last().copied().unwrap_or(0),
        t.len(),
        monotone
    ));
    r.line(format!(
        "     first ten: {:?}   last ten: {:?}",
        &t[..t.len().min(10)],
        &t[t.len().saturating_sub(10)..]
    ));
    r.line(format!(
        "     a human reads a 1-3 digit integer; the largest seen anywhere here is {max}."
    ));
    assert_eq!(t.last().copied(), Some(0));

    // 3. kill at ~70%, resume from the typed code
    r.line("");
    let big = text_corpus(big_bytes);
    let p = presets().remove(1);
    let total_chunks = Encoder::build(big.as_slice(), Config::default())
        .manifest()
        .chunk_count as usize;
    let kill_at = (total_chunks * 7).div_ceil(10);
    let first = run_transfer(
        &p,
        &big,
        Opts {
            stop_after: Some(kill_at),
            // Chunks are sent in order here so "died at 70%" means the first 70%,
            // which is what a resume code can express (ADR-0005: one integer).
            only: Some((0..total_chunks).collect()),
            ..Default::default()
        },
    );
    let code = first
        .resume_code
        .unwrap_or_else(|| ResumeCode::new(first.chunks_done as u32, 0));
    let typed = code.encode();
    r.line(format!(
        "  3. killed at {}/{} chunks ({:.1}% = {} of {} B on disk). Receiver screen: \"{}\"",
        first.chunks_done,
        total_chunks,
        100.0 * first.chunks_done as f64 / total_chunks as f64,
        first.delivered_bytes,
        big.len(),
        typed
    ));
    // The human types it back in, in whatever case they feel like.
    let parsed = ResumeCode::decode(&typed.to_lowercase()).expect("typed code parses");
    let resumed = run_transfer(
        &p,
        &big,
        Opts {
            sink: Some(first.sink),
            resume_from: Some(parsed),
            ..Default::default()
        },
    );
    let out = {
        let mut sink = resumed.sink;
        sink.to_vec()
    };
    r.line(format!(
        "     typed back as \"{}\" -> chunk {} need {}; {} retained chunks re-read off the sink and re-verified",
        typed.to_lowercase(),
        parsed.chunk,
        parsed.need,
        resumed.reverified_chunks
    ));
    r.line(format!(
        "     re-sent {} chunks in {} frames ({:.1}% of a fresh transfer); byte-identical: {}; whole-file BLAKE3: {}",
        resumed.chunks_done,
        resumed.frames_emitted,
        100.0 * resumed.chunks_done as f64 / total_chunks as f64,
        out == big,
        resumed.ok_hash
    ));
    assert!(out == big, "resumed file must be byte-identical");
    assert!(resumed.ok_hash, "resumed transfer must verify");

    // 4. a hopeless camera must fail loudly and fast
    r.line("");
    let hopeless = Channel {
        blur_sigma: 9.0,
        resample: 0.14,
        noise: 40.0,
        jpeg: 0.9,
        vignette: 0.5,
        ..Channel::potato_handheld()
    };
    let hp = Preset {
        name: "hopeless",
        ch: hopeless,
        pal: &P8,
        cell: 20,
        tear_every: 0,
    };
    let spec = geometry::frame_spec(W, H, hp.cell);
    let cap = spec.capacity_bytes(hp.pal);
    let fake = vec![7u8; cap];
    let t0 = Instant::now();
    let mut tried = 0usize;
    let mut any = false;
    const GIVE_UP_FRAMES: usize = 15; // one second at 15 FPS
    for i in 0..GIVE_UP_FRAMES {
        let out = shoot(&spec, hp.pal, &hp.ch, i as u32, &fake);
        tried += 1;
        if out.decoded.is_some() {
            any = true;
            break;
        }
    }
    let el = t0.elapsed();
    r.line(format!(
        "  4. hopeless camera: {tried} frames tried, any decode = {any}, gave up after {:.2}s of\n     simulated capture ({:.0} ms of real CPU). rectify() returns None (no fiducials),\n     so the UI can say \"cannot see the code — move closer / clean the lens\" at frame {tried},\n     never hang at 0%.",
        tried as f64 / 15.0,
        el.as_secs_f64() * 1000.0
    ));
    assert!(!any, "the hopeless channel must not decode");

    // ------------------------------------------------------------- artifacts
    let _ = std::fs::write("artifacts/e2e-report.txt", &r.buf);
    let _ = std::fs::write("artifacts/e2e-waterfall.csv", &csv);
    println!();
    println!("artifact: artifacts/e2e-report.txt");
    println!("artifact: artifacts/e2e-waterfall.csv");
}
