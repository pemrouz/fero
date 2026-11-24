// Licensed under the Apache License, Version 2.0. See the LICENSE and NOTICE
// files of this crate.

//! The one bridge between `u64` and slice positions.
//!
//! Raft's state and messages hold only `u64` (the WASM build is 32-bit, so a
//! machine-sized integer would change meaning there). Rust slices are indexed
//! by a machine-sized integer. These helpers do the conversion, and they are
//! the only code in the crate that names that type.

/// Turns a `u64` into a slice position.
///
/// Panics if the value does not fit, which can only happen on a 32-bit
/// machine with a position past 4 billion. Such a slice could not exist there.
#[inline]
#[must_use]
pub fn ix(i: u64) -> usize {
    match usize::try_from(i) {
        Ok(v) => v,
        Err(_) => panic!("index {i} does not fit this machine's slice positions"),
    }
}

/// Turns a length or position that Rust handed out into a `u64`.
#[inline]
#[must_use]
pub fn n64(n: usize) -> u64 {
    // A machine-sized integer is at most 64 bits wide on every target Rust has.
    n as u64
}

/// The length of a slice, as a `u64`. Go's `len(s)`.
#[inline]
#[must_use]
pub fn len64<T>(s: &[T]) -> u64 {
    n64(s.len())
}
