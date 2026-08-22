//! Minimal RGB888 image buffer. No external image stack in the hot path.

#[derive(Clone, PartialEq)]
pub struct RgbImage {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>, // w*h*3, row-major
}

impl RgbImage {
    pub fn new(w: usize, h: usize) -> Self {
        Self {
            w,
            h,
            data: vec![0u8; w * h * 3],
        }
    }

    #[inline]
    pub fn px(&self, x: usize, y: usize) -> [u8; 3] {
        let i = (y * self.w + x) * 3;
        [self.data[i], self.data[i + 1], self.data[i + 2]]
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, c: [u8; 3]) {
        let i = (y * self.w + x) * 3;
        self.data[i] = c[0];
        self.data[i + 1] = c[1];
        self.data[i + 2] = c[2];
    }

    pub fn fill_rect(&mut self, x0: usize, y0: usize, w: usize, h: usize, c: [u8; 3]) {
        for y in y0..(y0 + h).min(self.h) {
            for x in x0..(x0 + w).min(self.w) {
                self.set(x, y, c);
            }
        }
    }

    /// Mean colour of a rectangle, as f32 so callers can threshold in a linear-ish space.
    pub fn mean_rect(&self, x0: usize, y0: usize, w: usize, h: usize) -> [f32; 3] {
        let (mut r, mut g, mut b, mut n) = (0f32, 0f32, 0f32, 0f32);
        for y in y0..(y0 + h).min(self.h) {
            for x in x0..(x0 + w).min(self.w) {
                let p = self.px(x, y);
                r += p[0] as f32;
                g += p[1] as f32;
                b += p[2] as f32;
                n += 1.0;
            }
        }
        if n == 0.0 {
            return [0.0; 3];
        }
        [r / n, g / n, b / n]
    }

    pub fn save_png(&self, path: &str) -> std::io::Result<()> {
        let file = std::fs::File::create(path)?;
        let w = std::io::BufWriter::new(file);
        let mut enc = png::Encoder::new(w, self.w as u32, self.h as u32);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header()?;
        writer.write_image_data(&self.data)?;
        Ok(())
    }
}
