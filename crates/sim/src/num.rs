//! The bridge between fixed-width numbers and slice positions.
//!
//! This is the only file of the crate that names `usize`. State and trace
//! hold `u32` and `u64` only, so a 32-bit and a 64-bit build agree.

/// A `u32` as a slice position.
#[must_use]
pub fn ix(i: u32) -> usize {
    usize::try_from(i).expect("a u32 fits a slice position")
}

/// A slice's length as a `u32`.
#[must_use]
pub fn len32<T>(s: &[T]) -> u32 {
    u32::try_from(s.len()).expect("the length fits 32 bits")
}

/// A slice's length as a `u64`.
#[must_use]
pub fn len64<T>(s: &[T]) -> u64 {
    u64::try_from(s.len()).expect("the length fits 64 bits")
}

/// A `u64` as a slice position.
#[must_use]
pub fn ix64(i: u64) -> usize {
    usize::try_from(i).expect("the position fits this machine")
}
