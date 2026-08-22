//! Symbol palettes. Every colour is an RGB-cube corner: each channel is 0 or 255,
//! so decoding is N independent binary decisions rather than a 3-D nearest-neighbour
//! search, and every symbol also lands on a distinct luma level (which survives the
//! 4:2:0 chroma subsampling every webcam applies).

pub const BLACK: [u8; 3] = [0, 0, 0];
pub const BLUE: [u8; 3] = [0, 0, 255];
pub const RED: [u8; 3] = [255, 0, 0];
pub const MAGENTA: [u8; 3] = [255, 0, 255];
pub const GREEN: [u8; 3] = [0, 255, 0];
pub const CYAN: [u8; 3] = [0, 255, 255];
pub const YELLOW: [u8; 3] = [255, 255, 0];
pub const WHITE: [u8; 3] = [255, 255, 255];

pub struct Palette {
    pub name: &'static str,
    pub colors: &'static [[u8; 3]],
    pub bits: u32,
}

/// The ladder floor of ADR-0011: luma only, no chroma at all. Nothing about a
/// camera can take this away short of failing to focus.
pub const P2: Palette = Palette {
    name: "P2",
    colors: &[BLACK, WHITE],
    bits: 1,
};

/// v1 default. Luma 0.00 / 0.30 / 0.70 / 1.00 -- evenly spread, and red<->cyan are
/// chroma opposites. Maximum separation in both the luma and chroma planes.
pub const P4: Palette = Palette {
    name: "P4",
    colors: &[BLACK, RED, CYAN, WHITE],
    bits: 2,
};

/// Full RGB-cube corners. Denser but blue (luma 0.114) sits close to black, and
/// cameras clip saturated red/blue hardest -- needs solid calibration to beat P4.
pub const P8: Palette = Palette {
    name: "P8",
    colors: &[BLACK, BLUE, RED, MAGENTA, GREEN, CYAN, YELLOW, WHITE],
    bits: 3,
};

pub const ALL: &[&Palette] = &[&P2, &P4, &P8];

#[inline]
pub fn luma(c: [f32; 3]) -> f32 {
    0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
}

impl Palette {
    #[inline]
    pub fn len(&self) -> usize {
        self.colors.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.colors.is_empty()
    }

    #[inline]
    pub fn color(&self, sym: u8) -> [u8; 3] {
        self.colors[sym as usize % self.colors.len()]
    }

    /// Nearest symbol against a *reference* palette (ideal colours, or the measured
    /// ones recovered from the calibration row). Luma-weighted so brightness -- the
    /// full-resolution channel -- dominates when chroma has been smeared.
    pub fn nearest(&self, c: [f32; 3], reference: &[[f32; 3]]) -> u8 {
        let mut best = 0usize;
        let mut best_d = f32::MAX;
        for (i, r) in reference.iter().enumerate() {
            let dl = luma(c) - luma(*r);
            let dr = c[0] - r[0];
            let dg = c[1] - r[1];
            let db = c[2] - r[2];
            // 2x weight on luma, 1x on raw channel distance.
            let d = 2.0 * dl * dl + 0.5 * (dr * dr + dg * dg + db * db);
            if d < best_d {
                best_d = d;
                best = i;
            }
        }
        best as u8
    }

    pub fn ideal_reference(&self) -> Vec<[f32; 3]> {
        self.colors
            .iter()
            .map(|c| [c[0] as f32, c[1] as f32, c[2] as f32])
            .collect()
    }
}
