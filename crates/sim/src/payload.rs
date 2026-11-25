//! The bytes of a client write. **Probe only**: the real shapes come with
//! the `wire` crate in slice 1.
//!
//! One write is:
//!
//! ```text
//! op      1 byte      0 set, 1 incr, 2 del
//! req     varint      the request id (unsigned LEB128)
//! key     varint + n  the length in bytes, then UTF-8
//! value   8 bytes     an IEEE-754 double, little end first; absent for del
//! ```
//!
//! This side never does float math. A value is a bit pattern picked from a
//! fixed table. The table has whole numbers, fractions, numbers from 2^32 up
//! and numbers from 2^53 up, because each takes a different path in a codec.

use crate::num::{ix, len32, len64};
use crate::rng::Rng;
use alloc::vec::Vec;

pub const OP_SET: u8 = 0;
pub const OP_INCR: u8 = 1;
pub const OP_DEL: u8 = 2;

/// The keys a write may name: plain, accented, fullwidth (above the UTF-16
/// surrogate range), an emoji (outside the first plane) and one more high
/// character of the first plane. All valid UTF-8.
pub const KEYS: [&str; 10] =
    ["a", "b", "c", "user:1", "user:2", "caf\u{e9}", "\u{ff5a}", "\u{1f600}", "na\u{ef}ve", "x\u{ffe6}y"];

/// Small whole numbers, and minus one.
const SMALL: [u64; 9] = [
    0x0000_0000_0000_0000, // 0
    0x3ff0_0000_0000_0000, // 1
    0x4000_0000_0000_0000, // 2
    0x4008_0000_0000_0000, // 3
    0x401c_0000_0000_0000, // 7
    0x4024_0000_0000_0000, // 10
    0x4045_0000_0000_0000, // 42
    0x4058_c000_0000_0000, // 99
    0xbff0_0000_0000_0000, // -1
];

/// Fractions.
const FRACTIONS: [u64; 6] = [
    0x3fc0_0000_0000_0000, // 0.125
    0x3fe0_0000_0000_0000, // 0.5
    0x3ff8_0000_0000_0000, // 1.5
    0x4006_0000_0000_0000, // 2.75
    0x401f_8000_0000_0000, // 7.875
    0x3fb9_9999_9999_999a, // 0.1
];

/// Numbers from 2^32 up.
const PAST_32: [u64; 4] = [
    0x41f0_0000_0000_0000, // 4294967296
    0x41f0_0000_0010_0000, // 4294967297
    0x41f0_0000_0630_0000, // 4294967395
    0x41f0_0000_0008_0000, // 4294967296.5
];

/// Numbers around and past 2^53, where a double stops holding every whole
/// number.
const PAST_53: [u64; 4] = [
    0x4340_0000_0000_0000, // 9007199254740992
    0x4340_0000_0000_0001, // 9007199254740994
    0x4340_0000_0000_0063, // 9007199254741190
    0x433f_ffff_ffff_ffff, // 9007199254740991
];

/// The bit patterns of 10, -1 and 3, for the scripted scenario.
pub const TEN: u64 = SMALL[5];
pub const MINUS_ONE: u64 = SMALL[8];
pub const THREE: u64 = SMALL[3];

/// Draws a value: 7 in 10 small, 1 in 10 each of the other three kinds.
pub fn draw_value(rng: &mut Rng) -> u64 {
    let kind = rng.below(10);
    let table: &[u64] = match kind {
        0..=6 => &SMALL,
        7 => &FRACTIONS,
        8 => &PAST_32,
        _ => &PAST_53,
    };
    table[ix(rng.below(len32(table)))]
}

/// Draws an op: 6 in 10 set, 3 in 10 incr, 1 in 10 del.
pub fn draw_op(rng: &mut Rng) -> u8 {
    match rng.below(10) {
        0..=5 => OP_SET,
        6..=8 => OP_INCR,
        _ => OP_DEL,
    }
}

/// Draws a key.
pub fn draw_key(rng: &mut Rng) -> &'static str {
    KEYS[ix(rng.below(len32(&KEYS)))]
}

/// Appends an unsigned LEB128 varint.
pub fn put_varint(buf: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        buf.push(v.to_le_bytes()[0] | 0x80);
        v >>= 7;
    }
    buf.push(v.to_le_bytes()[0]);
}

/// The bytes of one write.
#[must_use]
pub fn encode(op: u8, req: u64, key: &str, value_bits: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(24 + key.len());
    buf.push(op);
    put_varint(&mut buf, req);
    put_varint(&mut buf, len64(key.as_bytes()));
    buf.extend_from_slice(key.as_bytes());
    if op != OP_DEL {
        buf.extend_from_slice(&value_bits.to_le_bytes());
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_holds_what_its_comments_say() {
        let as_f64 = |t: &[u64]| -> Vec<f64> { t.iter().map(|b| f64::from_bits(*b)).collect() };
        assert_eq!(as_f64(&SMALL), [0.0, 1.0, 2.0, 3.0, 7.0, 10.0, 42.0, 99.0, -1.0]);
        assert_eq!(as_f64(&FRACTIONS), [0.125, 0.5, 1.5, 2.75, 7.875, 0.1]);
        assert_eq!(as_f64(&PAST_32), [4_294_967_296.0, 4_294_967_297.0, 4_294_967_395.0, 4_294_967_296.5]);
        assert_eq!(
            as_f64(&PAST_53),
            [9_007_199_254_740_992.0, 9_007_199_254_740_994.0, 9_007_199_254_741_190.0, 9_007_199_254_740_991.0]
        );
    }

    #[test]
    fn one_write_in_bytes() {
        // del "a", request 1.
        assert_eq!(encode(OP_DEL, 1, "a", 0), [2, 1, 1, b'a']);
        // set the emoji key to 1.5, request 2^32 + 1: a five-byte varint.
        let b = encode(OP_SET, (1 << 32) + 1, KEYS[7], FRACTIONS[2]);
        assert_eq!(&b[..6], [0, 0x81, 0x80, 0x80, 0x80, 0x10]);
        assert_eq!(&b[6..11], [4, 0xf0, 0x9f, 0x98, 0x80]);
        assert_eq!(&b[11..], [0, 0, 0, 0, 0, 0, 0xf8, 0x3f]);
    }
}
