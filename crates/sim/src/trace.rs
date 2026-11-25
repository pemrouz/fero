//! The trace hash: FNV-1a, 64 bits, over the bytes of every step.
//!
//! The hash is the run's fingerprint. Two builds of the simulator agree on a
//! seed when they give the same hash. Numbers go in as LEB128 varints, so
//! their bytes do not depend on the machine's word size.

const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const PRIME: u64 = 0x0000_0100_0000_01b3;

/// A running FNV-1a hash.
#[derive(Clone, Copy, Debug)]
pub struct Trace(u64);

impl Default for Trace {
    fn default() -> Trace {
        Trace::new()
    }
}

impl Trace {
    #[must_use]
    pub fn new() -> Trace {
        Trace(OFFSET)
    }

    /// The hash so far.
    #[must_use]
    pub fn value(&self) -> u64 {
        self.0
    }

    /// One byte.
    pub fn u8(&mut self, b: u8) {
        self.0 = (self.0 ^ u64::from(b)).wrapping_mul(PRIME);
    }

    /// A number, as an unsigned LEB128 varint.
    pub fn varint(&mut self, mut v: u64) {
        while v >= 0x80 {
            self.u8(v.to_le_bytes()[0] | 0x80);
            v >>= 7;
        }
        self.u8(v.to_le_bytes()[0]);
    }

    /// Eight bytes, little end first. For digests, which are never small.
    pub fn u64(&mut self, v: u64) {
        for b in v.to_le_bytes() {
            self.u8(b);
        }
    }

    /// A byte string: its length as a varint, then its bytes.
    pub fn bytes(&mut self, s: &[u8]) {
        self.varint(crate::num::len64(s));
        // Probe P2's planted trap. A machine-sized length is 4 bytes in the
        // WASM build and 8 in the native one, so the two hashes must differ.
        #[cfg(feature = "trap-width")]
        for b in s.len().to_le_bytes() {
            self.u8(b);
        }
        for b in s {
            self.u8(*b);
        }
    }
}

/// The FNV-1a hash of one byte string, from a fresh state.
#[must_use]
pub fn digest(s: &[u8]) -> u64 {
    let mut t = Trace::new();
    t.bytes(s);
    t.value()
}

#[cfg(test)]
mod tests {
    use super::Trace;

    #[test]
    fn fnv1a_reference_values() {
        // The published test vectors for 64-bit FNV-1a: "" and "a".
        let mut t = Trace::new();
        assert_eq!(t.value(), 0xcbf2_9ce4_8422_2325);
        t.u8(b'a');
        assert_eq!(t.value(), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn varint_bytes() {
        let mut a = Trace::new();
        a.varint(300);
        let mut b = Trace::new();
        b.u8(0xac);
        b.u8(0x02);
        assert_eq!(a.value(), b.value());
    }
}
