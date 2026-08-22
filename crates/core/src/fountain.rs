//! Fountain coding across frames (ADR-0004).
//!
//! This module is the *byte/packet* layer, deliberately below the pixel layer:
//! it turns one chunk (ADR-0006) into an **endless** stream of fixed-size coded
//! packets, and reassembles that chunk from any sufficiently large subset of
//! them, in any order, with duplicates and garbage present.
//!
//! Integration with the frame layer is meant to be trivial:
//!
//! ```text
//!   sender:   frame_payload = tx.next_packet()          // exactly `capacity` bytes
//!   header:   oti = tx.oti()                            // the 12 bytes ADR-0004 needs
//!   receiver: rx.push(&frame_payload); rx.needed_more()  // the integer of ADR-0005
//! ```
//!
//! Each packet carries RaptorQ's own 4-byte FEC Payload ID — a source block
//! number plus a 24-bit encoding symbol ID — so a packet is self-describing and the frame
//! header does not have to grow a sequence number. The only per-transfer state
//! the header must carry is the 12-byte `ObjectTransmissionInformation`.
//!
//! Pure: no I/O, no clock, no randomness of its own (ADR-0009).

use std::collections::HashSet;

use raptorq::{Decoder, EncodingPacket, ObjectTransmissionInformation, SourceBlockEncoder};

/// Bytes of RaptorQ FEC Payload ID prepended to every packet.
pub const PACKET_HEADER_BYTES: usize = 4;

/// RaptorQ encoding symbol IDs are a 24-bit field (RFC 6330 §3.2). The
/// `raptorq` crate asserts this in `PayloadId::new`, so it is a hard ceiling on
/// how many distinct packets one source block can ever emit.
pub const MAX_PACKETS_PER_BLOCK: u64 = 1 << 24;

/// Largest K' RaptorQ admits for a single source block (RFC 6330 §5.6).
pub const MAX_SOURCE_SYMBOLS: usize = 56403;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FountainError {
    /// `capacity` leaves no room for a symbol, or exceeds what a 16-bit symbol
    /// size can express.
    BadCapacity,
    /// Nothing to send.
    EmptyChunk,
    /// The chunk needs more source symbols than one RaptorQ block holds.
    ChunkTooLarge,
    /// The 12 OTI bytes do not describe a block this module can decode.
    BadOti,
}

impl core::fmt::Display for FountainError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let s = match self {
            FountainError::BadCapacity => "per-frame payload capacity out of range",
            FountainError::EmptyChunk => "chunk is empty",
            FountainError::ChunkTooLarge => "chunk exceeds one RaptorQ source block",
            FountainError::BadOti => "malformed object transmission information",
        };
        f.write_str(s)
    }
}

impl std::error::Error for FountainError {}

/// The largest chunk that fits one source block at a given frame capacity.
pub fn max_chunk_bytes(capacity: usize) -> usize {
    capacity.saturating_sub(PACKET_HEADER_BYTES) * MAX_SOURCE_SYMBOLS
}

/// Endless sender-side fountain over exactly one chunk.
///
/// ADR-0005 has the sender looping forever with no back-channel, so this yields
/// fresh, distinct coded packets far past the source-symbol count — up to
/// [`MAX_PACKETS_PER_BLOCK`].
pub struct Transmitter {
    oti: ObjectTransmissionInformation,
    encoder: SourceBlockEncoder,
    /// Source symbols, pre-serialised. Emitted first so a clean channel costs
    /// exactly K frames.
    source: Vec<Vec<u8>>,
    /// Index of the next packet in the endless stream.
    next: u64,
}

impl Transmitter {
    /// `capacity` is the frame payload capacity in bytes (e.g. 3,927 for the
    /// potato layer of ADR-0011); every emitted packet is exactly that long.
    pub fn new(chunk: &[u8], capacity: usize) -> Result<Self, FountainError> {
        if chunk.is_empty() {
            return Err(FountainError::EmptyChunk);
        }
        if capacity <= PACKET_HEADER_BYTES || capacity - PACKET_HEADER_BYTES > u16::MAX as usize {
            return Err(FountainError::BadCapacity);
        }
        let symbol_size = capacity - PACKET_HEADER_BYTES;
        let k = chunk.len().div_ceil(symbol_size);
        if k > MAX_SOURCE_SYMBOLS {
            return Err(FountainError::ChunkTooLarge);
        }

        // One source block, alignment 1, no sub-blocks: the chunk sizes of
        // ADR-0006 are far below the single-block ceiling, and one block keeps
        // "how many more do I need" a single number for the human of ADR-0005.
        let oti =
            ObjectTransmissionInformation::new(chunk.len() as u64, symbol_size as u16, 1, 1, 1);

        let mut padded = chunk.to_vec();
        padded.resize(k * symbol_size, 0);
        let encoder = SourceBlockEncoder::new(0, &oti, &padded);
        let source = encoder
            .source_packets()
            .into_iter()
            .map(|p| p.serialize())
            .collect();

        Ok(Self {
            oti,
            encoder,
            source,
            next: 0,
        })
    }

    /// The 12 bytes the frame header carries (ADR-0004).
    pub fn oti(&self) -> [u8; 12] {
        self.oti.serialize()
    }

    /// Number of source symbols: the theoretical minimum packet count.
    pub fn source_symbols(&self) -> usize {
        self.source.len()
    }

    /// Bytes of payload each packet carries (capacity minus the 4-byte FEC ID).
    pub fn symbol_size(&self) -> usize {
        self.oti.symbol_size() as usize
    }

    /// Index of the packet `next_packet` will return.
    pub fn position(&self) -> u64 {
        self.next
    }

    /// Restart the stream at an arbitrary index. Used to prove the endless
    /// property near the 24-bit ceiling without generating 16M packets.
    pub fn seek(&mut self, index: u64) {
        assert!(index < MAX_PACKETS_PER_BLOCK, "encoding symbol ID overflow");
        self.next = index;
    }

    /// The next distinct coded packet, exactly `capacity` bytes.
    ///
    /// Packets `0..K` are the source symbols; everything after is a repair
    /// symbol. Wraps back to 0 at [`MAX_PACKETS_PER_BLOCK`] rather than
    /// panicking, so a sender that literally never stops keeps sending
    /// something decodable.
    pub fn next_packet(&mut self) -> Vec<u8> {
        if self.next >= MAX_PACKETS_PER_BLOCK {
            self.next = 0;
        }
        let i = self.next;
        self.next += 1;
        let k = self.source.len() as u64;
        if i < k {
            self.source[i as usize].clone()
        } else {
            self.encoder.repair_packets((i - k) as u32, 1)[0].serialize()
        }
    }
}

impl core::fmt::Debug for Transmitter {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Transmitter")
            .field("symbol_size", &self.symbol_size())
            .field("source_symbols", &self.source_symbols())
            .field("position", &self.next)
            .finish()
    }
}

/// Receiver-side fountain: accepts packets in any order, tolerates duplicates
/// and garbage, and reports how many more it needs.
pub struct Receiver {
    oti: ObjectTransmissionInformation,
    decoder: Decoder,
    seen: HashSet<u32>,
    k: usize,
    packet_len: usize,
    /// Packets accepted (unique, well-formed) at the moment decoding completed.
    packets_at_completion: Option<usize>,
    result: Option<Vec<u8>>,
}

impl Receiver {
    /// Build from the 12 OTI bytes read out of a frame header.
    pub fn from_oti(oti: [u8; 12]) -> Result<Self, FountainError> {
        let oti = ObjectTransmissionInformation::deserialize(&oti);
        if oti.symbol_size() == 0 || oti.source_blocks() != 1 || oti.transfer_length() == 0 {
            return Err(FountainError::BadOti);
        }
        let symbol_size = oti.symbol_size() as usize;
        let k = (oti.transfer_length() as usize).div_ceil(symbol_size);
        if k == 0 || k > MAX_SOURCE_SYMBOLS {
            return Err(FountainError::BadOti);
        }
        Ok(Self {
            decoder: Decoder::new(oti),
            oti,
            seen: HashSet::new(),
            k,
            packet_len: symbol_size + PACKET_HEADER_BYTES,
            packets_at_completion: None,
            result: None,
        })
    }

    /// Number of source symbols: the theoretical minimum packet count.
    pub fn source_symbols(&self) -> usize {
        self.k
    }

    /// Unique, well-formed packets accepted so far.
    pub fn accepted(&self) -> usize {
        self.seen.len()
    }

    /// Offer one frame payload. Returns `true` if it was new and well-formed.
    ///
    /// Duplicates and garbage return `false` and are *not* errors — out-of-order
    /// and repeated frames are the normal case (ADR-0004).
    pub fn push(&mut self, packet: &[u8]) -> bool {
        if self.result.is_some() {
            return false;
        }
        if packet.len() != self.packet_len {
            return false;
        }
        // Reject anything not addressed to our single source block. The 24-bit
        // ESI field cannot overflow, so no further bounds check is needed.
        if packet[0] != 0 {
            return false;
        }
        let esi = ((packet[1] as u32) << 16) | ((packet[2] as u32) << 8) | (packet[3] as u32);
        if !self.seen.insert(esi) {
            return false;
        }
        // Decoding is only attempted once enough symbols exist; below K the
        // crate short-circuits, so this stays cheap.
        if self.seen.len() >= self.k {
            if let Some(data) = self.decoder.decode(EncodingPacket::deserialize(packet)) {
                self.packets_at_completion = Some(self.seen.len());
                self.result = Some(data);
            }
        } else {
            self.decoder
                .add_new_packet(EncodingPacket::deserialize(packet));
        }
        true
    }

    pub fn is_complete(&self) -> bool {
        self.result.is_some()
    }

    /// The integer a human reads off the screen (ADR-0005): how many more
    /// frames are still wanted. Zero once complete; never zero before.
    pub fn needed_more(&self) -> usize {
        if self.result.is_some() {
            0
        } else {
            self.k.saturating_sub(self.seen.len()).max(1)
        }
    }

    /// Unique packets consumed to finish. `None` until complete.
    pub fn packets_used(&self) -> Option<usize> {
        self.packets_at_completion
    }

    /// The reconstructed chunk, or `None` if more packets are needed.
    pub fn finish(&self) -> Option<Vec<u8>> {
        self.result.clone()
    }

    /// The OTI this receiver was configured with.
    pub fn oti(&self) -> [u8; 12] {
        self.oti.serialize()
    }
}

impl core::fmt::Debug for Receiver {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Receiver")
            .field("source_symbols", &self.k)
            .field("accepted", &self.seen.len())
            .field("complete", &self.result.is_some())
            .finish()
    }
}
