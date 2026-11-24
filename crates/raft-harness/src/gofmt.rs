// Licensed under the Apache License, Version 2.0.

//! The subset of Go's `fmt` that the expected outputs need.
//!
//! Rust's own formatting covers most verbs: `%d` is `{}`, `%x` is `{:x}`,
//! `%5d` is `{:5}`, `%s` of a type with `String()` is `{}` of a type with
//! `Display`. What is left is how Go's `%v` prints containers, and `%q`.
//! Each helper here wraps a value and prints it the Go way.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub use raft::gostd::Quote;

/// `%v` of a slice: `[a b c]`. Each element prints with its own `Display`.
pub struct Slice<'a, T>(pub &'a [T]);

impl<T: fmt::Display> fmt::Display for Slice<'_, T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[")?;
        for (i, v) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str(" ")?;
            }
            write!(f, "{v}")?;
        }
        f.write_str("]")
    }
}

/// `%v` of a `map[uint64]struct{}`: `map[1:{} 2:{}]`, keys sorted.
pub struct MapSet<'a>(pub &'a BTreeSet<u64>);

impl fmt::Display for MapSet<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("map[")?;
        for (i, k) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str(" ")?;
            }
            write!(f, "{k}:{{}}")?;
        }
        f.write_str("]")
    }
}

/// `%v` of a map: `map[k:v k:v]`, keys sorted.
pub struct Map<'a, K, V>(pub &'a BTreeMap<K, V>);

impl<K: fmt::Display, V: fmt::Display> fmt::Display for Map<'_, K, V> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("map[")?;
        for (i, (k, v)) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str(" ")?;
            }
            write!(f, "{k}:{v}")?;
        }
        f.write_str("]")
    }
}

/// `%v` of a `[]byte`: `[104 105]`.
pub struct Bytes<'a>(pub &'a [u8]);

impl fmt::Display for Bytes<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        Slice(self.0).fmt(f)
    }
}

/// `%x` of a string or `[]byte`: two hex digits per byte.
pub struct Hex<'a>(pub &'a [u8]);

impl fmt::Display for Hex<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for b in self.0 {
            write!(f, "{b:02x}")?;
        }
        Ok(())
    }
}

/// `%q` of a string.
pub fn quote(s: &str) -> String {
    Quote(s.as_bytes()).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbs() {
        // Each expected string is what Go 1.26 prints for the same value.
        assert_eq!(Slice(&[1u64, 2, 3]).to_string(), "[1 2 3]");
        assert_eq!(Slice::<u64>(&[]).to_string(), "[]");
        assert_eq!(MapSet(&BTreeSet::from([2, 1])).to_string(), "map[1:{} 2:{}]");
        assert_eq!(Map(&BTreeMap::from([(2u64, true), (1, false)])).to_string(), "map[1:false 2:true]");
        assert_eq!(Bytes(b"hi").to_string(), "[104 105]");
        assert_eq!(Hex(b"hi").to_string(), "6869");
        assert_eq!(quote("a\"b\\c\n\t\x01é"), "\"a\\\"b\\\\c\\n\\t\\x01é\"");
        assert_eq!(Quote(&[0xff, b'a']).to_string(), "\"\\xffa\"");
        assert_eq!(format!("{:5}|{:x}|{:<4}|", 42u64, 255u64, "ab"), "   42|ff|ab  |");
    }
}
