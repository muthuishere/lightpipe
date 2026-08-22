# Bit packing: the least glamorous invariant in the system

Between "a byte stream" and "a grid of coloured cells" sits a conversion nobody
writes blog posts about: turning 8-bit bytes into n-bit symbols, where n is 1, 2
or 3 and does not divide 8.

`crates/core/src/codec.rs` is 49 lines. It is also the piece that, if it were
subtly wrong, would produce a system that works perfectly at P2 and P4 and
mysteriously corrupts data at P8. Worth understanding exactly.

## The problem

P8 carries 3 bits per cell. 8 does not divide by 3. So symbol boundaries do not
line up with byte boundaries, and a single byte is spread across parts of three
symbols:

```
   bytes    | b0 b0 b0 b0 b0 b0 b0 b0 | b1 b1 b1 b1 b1 b1 b1 b1 | b2 ...
   bit idx    0  1  2  3  4  5  6  7    8  9 10 11 12 13 14 15   16

   3-bit    |  s0   |  s1   |  s2   |  s3   |  s4   |  s5   |  s6  ...
   symbols     0-2     3-5     6-8     9-11   12-14   15-17

   s2 straddles the b0/b1 boundary. every third symbol does.
```

Get the endianness of that wrong in one direction and not the other and the
round-trip still passes for a single byte, then fails on the third.

## The rule: MSB-first, everywhere

The whole file rests on one invariant, stated in its first line: **MSB-first.**

Bit index `i` of the stream is bit `7 - (i % 8)` of byte `i / 8` — the
most-significant bit of a byte is bit 0 of the stream. And within a symbol, the
bits are accumulated `sym = (sym << 1) | v`, so the first bit taken is the
symbol's most significant.

Both directions use the identical index arithmetic, which is what actually
guarantees the round-trip:

```rust
// pack:   bit_idx = i * bits + b
let v = (data[bit_idx / 8] >> (7 - (bit_idx % 8))) & 1;
sym = (sym << 1) | v;

// unpack: bit_idx = i * bits + b
let v = (s >> (bits - 1 - b)) & 1;
out[bit_idx / 8] |= v << (7 - (bit_idx % 8));
```

Same expression for `bit_idx`. Same `7 - (bit_idx % 8)` shift. The unpacker is a
mechanical transposition of the packer, not an independent re-derivation — which
is the only way to write this kind of code and be confident in it.

MSB-first specifically (rather than LSB-first) is the conventional choice for wire
formats, and it means a hex dump of the symbol stream reads in the same order as a
hex dump of the bytes. There is no performance argument either way; there is a
strong argument for picking one and never wavering.

## Padding, and why it is not a bug

`bytes_to_symbols` computes `n = (data.len() * 8).div_ceil(bits)` and pads the
final partial symbol with zero bits. `symbols_to_bytes` takes an explicit
`out_len` and returns early once it has written that many bytes, ignoring
whatever the tail symbols contained.

So a frame's final cells carry bits that mean nothing, plus `render_band` pads all
remaining cells with symbol 0.

This padding tail is not merely tolerated — it showed up as an observable in the
S2 integrity measurement. Of 100,000 corrupted frames, 309 were **accepted** and
every one returned byte-identical data: the corruption had landed entirely in the
padding tail, outside the `payload[..payload_len]` range the CRC covers. The
system is correct precisely because `payload_len` is authoritative and the tail is
explicitly untrusted. See
[CRC32 and erasure semantics](04-crc32-and-erasure-semantics.md).

## The capacity arithmetic

Two helpers, and they are deliberately not inverses:

```rust
symbols_for_bytes(n, bits) = (n * 8).div_ceil(bits)   // round UP
bytes_for_symbols(n, bits) = (n * bits) / 8           // round DOWN
```

Encoding rounds up because you must not drop the last few bits. Capacity rounds
down because you must not promise room you do not have. Both directions are
conservative, in opposite senses, which is exactly right for a format where an
off-by-one becomes a corrupt frame.

You can verify the chain by hand against
[`s2-integrity.txt`](../../artifacts/s2-integrity.txt). At 1920×1080, P4, 8 px
cells, `margin = cell = 8`:

```
   cols = (1920 - 16) / 8 = 238
   rows = (1080 - 16) / 8 = 133
   payload_rows = 133 - CALIB_ROWS(1) - HEADER_ROWS(2) = 130
   payload_cells = 130 * 238 = 30,940
   capacity = 30,940 * 2 bits / 8 = 7,735 B     <- matches the artifact
```

And at P2 (1 bit): 30,940 / 8 = 3,867 B — the number that replaced the pre-header
3,927 B when [the header band shifted the grid](08-cell-grid-aliasing.md).

## Header copies

`symbols_per_copy` is where this arithmetic earns its keep. The 25-byte header
record needs `(25 * 8).div_ceil(bits)` symbols: **100 at P4, 67 at P8**. The header
band's cell count divided by that gives the repeat count — 2 to 7 copies depending
on layout.

Each copy is packed **independently** rather than as one long bit stream. The code
comment gives the reason: every copy starts byte-aligned in symbol space and can
be lifted out without touching its neighbours. If the copies shared a bit stream,
extracting copy 3 would require correctly decoding copies 0–2 first — which
defeats the entire point of repeating the record.

That is the kind of detail that separates a format that degrades gracefully from
one that has redundancy on paper only.
