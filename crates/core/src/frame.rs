//! Frame geometry. Row 0 is the calibration strip; the rest is payload.
//! The header band and corner fiducials arrive in spikes S2 and S4.

use crate::palette::Palette;

#[derive(Clone, Copy, Debug)]
pub struct FrameSpec {
    pub width: usize,
    pub height: usize,
    pub cell: usize,
    pub margin: usize,
}

impl FrameSpec {
    pub const CALIB_ROWS: usize = 1;

    pub fn new(width: usize, height: usize, cell: usize) -> Self {
        Self {
            width,
            height,
            cell,
            margin: cell,
        }
    }

    pub fn cols(&self) -> usize {
        self.width.saturating_sub(2 * self.margin) / self.cell
    }

    pub fn rows(&self) -> usize {
        self.height.saturating_sub(2 * self.margin) / self.cell
    }

    pub fn payload_rows(&self) -> usize {
        self.rows().saturating_sub(Self::CALIB_ROWS)
    }

    pub fn payload_cells(&self) -> usize {
        self.payload_rows() * self.cols()
    }

    /// Payload bytes carried by one frame at this palette.
    pub fn capacity_bytes(&self, pal: &Palette) -> usize {
        (self.payload_cells() * pal.bits as usize) / 8
    }

    /// Top-left pixel of cell (col, row). Row 0 is the calibration strip.
    pub fn cell_origin(&self, col: usize, row: usize) -> (usize, usize) {
        (self.margin + col * self.cell, self.margin + row * self.cell)
    }

    /// The inner region of a cell used for sampling — inset to stay clear of
    /// bleed from neighbouring cells once the channel has blurred things.
    pub fn sample_rect(&self, col: usize, row: usize) -> (usize, usize, usize, usize) {
        let (x, y) = self.cell_origin(col, row);
        let inset = (self.cell / 4).max(1);
        let size = self.cell.saturating_sub(2 * inset).max(1);
        (x + inset, y + inset, size, size)
    }
}
