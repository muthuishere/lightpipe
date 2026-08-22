//! `docs/contracts/wasm-api.md`, implemented.
//!
//! Everything here is a thin shell: the work lives in [`engine`], which knows
//! nothing about JS so that `src/bin/bench_native.rs` can run the identical code
//! natively and price the boundary by difference.
//!
//! **No panics cross the boundary.** The release wasm is built with
//! `panic = "abort"`, so a panic does not unwind into JS — it aborts the module and
//! takes the page with it. Every fallible entry point therefore returns
//! `null`/`false` and every `Option`/`Result` inside is matched, never unwrapped.

pub mod engine;

#[cfg(target_arch = "wasm32")]
mod bindings {
    use crate::engine::{self, Profile, Receiver, Sender};
    use js_sys::{Object, Reflect, Uint8Array};
    use wasm_bindgen::prelude::*;

    fn obj() -> Object {
        Object::new()
    }

    fn set_num(o: &Object, k: &str, v: f64) {
        let _ = Reflect::set(o, &JsValue::from_str(k), &JsValue::from_f64(v));
    }

    fn set_bool(o: &Object, k: &str, v: bool) {
        let _ = Reflect::set(o, &JsValue::from_str(k), &JsValue::from_bool(v));
    }

    fn set_str(o: &Object, k: &str, v: &str) {
        let _ = Reflect::set(o, &JsValue::from_str(k), &JsValue::from_str(v));
    }

    fn get_num(opts: &JsValue, k: &str) -> Option<f64> {
        if opts.is_undefined() || opts.is_null() {
            return None;
        }
        Reflect::get(opts, &JsValue::from_str(k))
            .ok()
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite() && *v >= 0.0)
    }

    fn get_str(opts: &JsValue, k: &str) -> Option<String> {
        if opts.is_undefined() || opts.is_null() {
            return None;
        }
        Reflect::get(opts, &JsValue::from_str(k))
            .ok()
            .and_then(|v| v.as_string())
    }

    fn manifest_obj(m: &optical_core::pipeline::Manifest) -> Object {
        let o = obj();
        set_num(&o, "totalBytes", m.total_size as f64);
        set_num(&o, "chunkSize", m.chunk_size as f64);
        set_num(&o, "chunkCount", m.chunk_count as f64);
        set_bool(
            &o,
            "compressed",
            m.encoding == optical_core::pipeline::Encoding::Gzip,
        );
        set_str(&o, "displayCode", &m.display_code());
        o
    }

    // -----------------------------------------------------------------------
    // sender
    // -----------------------------------------------------------------------

    #[wasm_bindgen(js_name = OpticalSender)]
    pub struct OpticalSender {
        inner: Sender,
    }

    #[wasm_bindgen(js_class = OpticalSender)]
    impl OpticalSender {
        /// `null` on bad input (empty payload, impossible geometry, unknown profile).
        pub fn create(bytes: &Uint8Array, opts: &JsValue) -> Option<OpticalSender> {
            let profile = match get_str(opts, "profile") {
                Some(s) => Profile::parse(&s)?,
                None => Profile::parse("auto")?,
            };
            let chunk_size = get_num(opts, "chunkSize").unwrap_or(262_144.0) as usize;
            let width = get_num(opts, "width").unwrap_or(1920.0) as usize;
            let height = get_num(opts, "height").unwrap_or(1080.0) as usize;
            let data = bytes.to_vec();
            Sender::create(data, profile, chunk_size, width, height)
                .map(|inner| OpticalSender { inner })
        }

        pub fn manifest(&self) -> Object {
            manifest_obj(self.inner.manifest())
        }

        /// The serialised manifest — what the sender actually broadcasts, and the
        /// only form that carries the per-chunk BLAKE3 hashes `resume` needs.
        /// Not in the contract; see the implementation notes.
        #[wasm_bindgen(js_name = manifestBytes)]
        pub fn manifest_bytes(&self) -> Uint8Array {
            let v = engine::encode_manifest(self.inner.manifest());
            Uint8Array::from(&v[..])
        }

        /// `{ptr, len, width, height}` into wasm linear memory. The buffer is
        /// allocated once at `create` and rewritten in place, so `ptr` is stable and
        /// no allocation happens per frame. `null` only if the frame cannot be built.
        #[wasm_bindgen(js_name = nextFrame)]
        pub fn next_frame(&mut self) -> Option<Object> {
            let f = self.inner.next_frame()?;
            let o = obj();
            set_num(&o, "ptr", f.ptr as usize as f64);
            set_num(&o, "len", f.len as f64);
            set_num(&o, "width", f.width as f64);
            set_num(&o, "height", f.height as f64);
            Some(o)
        }

        pub fn progress(&self) -> Object {
            let o = obj();
            set_num(&o, "chunk", self.inner.chunk_index() as f64);
            set_num(&o, "chunkCount", self.inner.manifest().chunk_count as f64);
            set_num(&o, "framesEmitted", self.inner.frames_emitted() as f64);
            o
        }

        /// `false` when the profile is unknown or will not fit the frame.
        #[wasm_bindgen(js_name = setProfile)]
        pub fn set_profile(&mut self, p: &str) -> bool {
            match Profile::parse(p) {
                Some(pr) => self.inner.set_profile(pr),
                None => false,
            }
        }

        /// Corner fiducials cost nothing but are pure overhead when the harness
        /// feeds frames back on an aligned grid. Test hook, not in the contract.
        #[wasm_bindgen(js_name = setFiducials)]
        pub fn set_fiducials(&mut self, on: bool) {
            self.inner.set_stamp_fiducials(on);
        }

        /// Render `n` frames entirely inside wasm. Used only to price the boundary.
        #[wasm_bindgen(js_name = benchFrames)]
        pub fn bench_frames(&mut self, n: u32) -> u32 {
            let mut ok = 0;
            for _ in 0..n {
                if self.inner.next_frame().is_some() {
                    ok += 1;
                }
            }
            ok
        }

        pub fn free(self) {}
    }

    // -----------------------------------------------------------------------
    // receiver
    // -----------------------------------------------------------------------

    #[wasm_bindgen(js_name = OpticalReceiver)]
    pub struct OpticalReceiver {
        inner: Receiver,
    }

    #[wasm_bindgen(js_class = OpticalReceiver)]
    impl OpticalReceiver {
        pub fn create(opts: &JsValue) -> Option<OpticalReceiver> {
            let profile = match get_str(opts, "profile") {
                Some(s) => Profile::parse(&s)?,
                None => Profile::parse("auto")?,
            };
            let width = get_num(opts, "width").unwrap_or(1920.0) as usize;
            let height = get_num(opts, "height").unwrap_or(1080.0) as usize;
            Receiver::create(profile, width, height).map(|inner| OpticalReceiver { inner })
        }

        /// `manifest` must be the bytes from `OpticalSender.manifestBytes()`;
        /// `haveChunks` is an LSB-first bitmap. `null` if the code fails its check
        /// character or the manifest does not parse.
        pub fn resume(
            code: &str,
            manifest: &Uint8Array,
            have_chunks: &Uint8Array,
            opts: &JsValue,
        ) -> Option<OpticalReceiver> {
            let profile = match get_str(opts, "profile") {
                Some(s) => Profile::parse(&s)?,
                None => Profile::parse("auto")?,
            };
            let width = get_num(opts, "width").unwrap_or(1920.0) as usize;
            let height = get_num(opts, "height").unwrap_or(1080.0) as usize;
            Receiver::resume(
                profile,
                width,
                height,
                code,
                &manifest.to_vec(),
                &have_chunks.to_vec(),
            )
            .map(|inner| OpticalReceiver { inner })
        }

        /// Borrow the buffer the camera frame is written into. `ptr` is stable for
        /// the life of the receiver; JS writes RGBA straight in, no copy.
        #[wasm_bindgen(js_name = frameBuffer)]
        pub fn frame_buffer(&mut self) -> Object {
            let (ptr, len) = self.inner.frame_buffer();
            let o = obj();
            set_num(&o, "ptr", ptr as usize as f64);
            set_num(&o, "len", len as f64);
            o
        }

        #[wasm_bindgen(js_name = pushFrame)]
        pub fn push_frame(&mut self) -> Object {
            let r = self.inner.push_frame();
            let o = obj();
            set_bool(&o, "accepted", r.accepted);
            if let Some(reason) = r.reason {
                set_str(&o, "reason", reason.as_str());
            }
            if let Some(c) = r.chunk_complete {
                set_num(&o, "chunkComplete", c as f64);
            }
            set_num(&o, "neededMore", r.needed_more as f64);
            set_num(&o, "quality", r.quality as f64);
            set_bool(&o, "rectified", r.rectified);
            o
        }

        pub fn manifest(&self) -> Option<Object> {
            self.inner.manifest().map(manifest_obj)
        }

        #[wasm_bindgen(js_name = neededMore)]
        pub fn needed_more(&self) -> u32 {
            self.inner.needed_more()
        }

        #[wasm_bindgen(js_name = resumeCode)]
        pub fn resume_code(&self) -> String {
            self.inner.resume_code()
        }

        #[wasm_bindgen(js_name = displayCode)]
        pub fn display_code(&self) -> Option<String> {
            self.inner.display_code()
        }

        /// `{index, ptr, len}` or `null`. The bytes stay valid until the next call.
        #[wasm_bindgen(js_name = takeChunk)]
        pub fn take_chunk(&mut self) -> Option<Object> {
            let (index, ptr, len) = self.inner.take_chunk()?;
            let o = obj();
            set_num(&o, "index", index as f64);
            set_num(&o, "ptr", ptr as usize as f64);
            set_num(&o, "len", len as f64);
            Some(o)
        }

        #[wasm_bindgen(js_name = isComplete)]
        pub fn is_complete(&self) -> bool {
            self.inner.is_complete()
        }

        /// Verify one chunk of already-written output against the manifest hash,
        /// so the caller can build an honest `haveChunks` bitmap off OPFS.
        #[wasm_bindgen(js_name = verifyChunk)]
        pub fn verify_chunk(&self, index: u32, plain: &Uint8Array) -> bool {
            self.inner.verify_chunk(index as usize, &plain.to_vec())
        }

        /// Turn the fiducial search off when frames are known to be aligned.
        /// Test hook, not in the contract.
        #[wasm_bindgen(js_name = setGeometry)]
        pub fn set_geometry(&mut self, on: bool) {
            self.inner.set_geometry(on);
        }

        #[wasm_bindgen(js_name = setProfile)]
        pub fn set_profile(&mut self, p: &str) -> bool {
            match Profile::parse(p) {
                Some(pr) => self.inner.set_profile(pr),
                None => false,
            }
        }

        pub fn stats(&self) -> Object {
            let o = obj();
            set_num(&o, "framesSeen", self.inner.frames_seen() as f64);
            set_num(&o, "framesAccepted", self.inner.frames_accepted() as f64);
            set_num(&o, "completedChunks", self.inner.completed_chunks() as f64);
            set_num(&o, "quality", self.inner.quality() as f64);
            o
        }

        /// Decode the current frame buffer `n` times without returning to JS.
        /// Used only to price the boundary.
        #[wasm_bindgen(js_name = benchPush)]
        pub fn bench_push(&mut self, n: u32) -> u32 {
            let mut ok = 0;
            for _ in 0..n {
                if self.inner.push_frame().accepted {
                    ok += 1;
                }
            }
            ok
        }

        /// Run the full fiducial-detect + rectify + decode path `n` times.
        #[wasm_bindgen(js_name = benchGeometry)]
        pub fn bench_geometry(&mut self, n: u32) -> u32 {
            let mut ok = 0;
            for _ in 0..n {
                if self.inner.geometry_only() {
                    ok += 1;
                }
            }
            ok
        }

        pub fn free(self) {}
    }

    // -----------------------------------------------------------------------
    // boundary microbenchmarks
    // -----------------------------------------------------------------------

    /// The cheapest possible crossing: no args, no return value, no work.
    #[wasm_bindgen(js_name = benchNoop)]
    pub fn bench_noop() {}

    /// A crossing that takes and returns a scalar.
    #[wasm_bindgen(js_name = benchNoopArg)]
    pub fn bench_noop_arg(a: u32) -> u32 {
        a.wrapping_add(1)
    }

    /// A crossing that builds the same 4-field plain object `nextFrame` returns,
    /// and does nothing else — this is the marshalling half of the per-frame cost.
    #[wasm_bindgen(js_name = benchFrameObject)]
    pub fn bench_frame_object() -> Object {
        let o = obj();
        set_num(&o, "ptr", 0.0);
        set_num(&o, "len", 0.0);
        set_num(&o, "width", 1920.0);
        set_num(&o, "height", 1080.0);
        o
    }

    /// Sum every byte of a slice already in linear memory, given ptr+len — proves a
    /// pointer handed to JS addresses the same bytes wasm sees.
    #[wasm_bindgen(js_name = checksumAt)]
    pub fn checksum_at(ptr: u32, len: u32) -> u32 {
        let s = unsafe { core::slice::from_raw_parts(ptr as *const u8, len as usize) };
        let mut h: u32 = 2_166_136_261;
        for b in s {
            h ^= *b as u32;
            h = h.wrapping_mul(16_777_619);
        }
        h
    }

    /// Payload bytes one frame carries at this profile/geometry.
    #[wasm_bindgen(js_name = frameCapacity)]
    pub fn frame_capacity(profile: &str, width: u32, height: u32) -> u32 {
        match Profile::parse(profile) {
            Some(p) => engine::frame_capacity(p, width as usize, height as usize) as u32,
            None => 0,
        }
    }
}
