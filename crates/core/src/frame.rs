//! Frame geometry. Row 0 is the calibration strip, the next `HEADER_ROWS` rows are
//! the header band (S2), and everything below is payload. Corner fiducials arrive
//! in S4.

use crate::palette::Palette;

#[derive(Clone, Copy, Debug)]
pub struct FrameSpec {
    pub width: usize,
    pub height: usize,
    pub cell: usize,
    pub margin: usize,
}

impl FrameSpec {
    /// Calibration strip: one row of cycling palette colours at the very top.
    pub const CALIB_ROWS: usize = 1;
    /// Header band: the CRC-protected record, repeated as often as it fits.
    pub const HEADER_ROWS: usize = 2;

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

    /// First grid row of the header band.
    pub fn header_row0(&self) -> usize {
        Self::CALIB_ROWS
    }

    /// Header rows actually present (a very small frame may not fit them all).
    pub fn header_rows(&self) -> usize {
        Self::HEADER_ROWS.min(self.rows().saturating_sub(Self::CALIB_ROWS))
    }

    pub fn header_cells(&self) -> usize {
        self.header_rows() * self.cols()
    }

    /// First grid row of the payload region.
    pub fn payload_row0(&self) -> usize {
        Self::CALIB_ROWS + Self::HEADER_ROWS
    }

    pub fn payload_rows(&self) -> usize {
        self.rows()
            .saturating_sub(Self::CALIB_ROWS + Self::HEADER_ROWS)
    }

    pub fn payload_cells(&self) -> usize {
        self.payload_rows() * self.cols()
    }

    /// Payload bytes carried by one frame at this palette. Excludes the
    /// calibration strip and the header band.
    pub fn capacity_bytes(&self, pal: &Palette) -> usize {
        (self.payload_cells() * pal.bits as usize) / 8
    }

    /// Bytes the header band can hold at this palette (all copies together).
    pub fn header_band_bytes(&self, pal: &Palette) -> usize {
        (self.header_cells() * pal.bits as usize) / 8
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
