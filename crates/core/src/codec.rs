//! Bit packing between byte streams and n-bit symbol streams. MSB-first.

pub fn bytes_to_symbols(data: &[u8], bits: u32) -> Vec<u8> {
    assert!((1..=8).contains(&bits));
    let total_bits = data.len() * 8;
    let n = total_bits.div_ceil(bits as usize);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let mut sym = 0u8;
        for b in 0..bits as usize {
            let bit_idx = i * bits as usize + b;
            let v = if bit_idx < total_bits {
                (data[bit_idx / 8] >> (7 - (bit_idx % 8))) & 1
            } else {
                0
            };
            sym = (sym << 1) | v;
        }
        out.push(sym);
    }
    out
}

pub fn symbols_to_bytes(syms: &[u8], bits: u32, out_len: usize) -> Vec<u8> {
    assert!((1..=8).contains(&bits));
    let mut out = vec![0u8; out_len];
    let total_bits = out_len * 8;
    for (i, s) in syms.iter().enumerate() {
        for b in 0..bits as usize {
            let bit_idx = i * bits as usize + b;
            if bit_idx >= total_bits {
                return out;
            }
            let v = (s >> (bits as usize - 1 - b)) & 1;
            out[bit_idx / 8] |= v << (7 - (bit_idx % 8));
        }
    }
    out
}

/// Symbols needed to carry `n` bytes at `bits` bits per symbol.
pub fn symbols_for_bytes(n: usize, bits: u32) -> usize {
    (n * 8).div_ceil(bits as usize)
}

/// Bytes carried by `n` symbols at `bits` bits per symbol.
pub fn bytes_for_symbols(n: usize, bits: u32) -> usize {
    (n * bits as usize) / 8
}
