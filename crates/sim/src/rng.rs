//! The seeded generator: splitmix64.
//!
//! One `u64` of state. No floats: a chance is a whole number of parts per
//! 1,000, and a pick below `n` is the high half of a 64-bit product.

/// A seeded stream of numbers.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    #[must_use]
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }

    /// The next 64 bits.
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        mix(self.0)
    }

    /// A number in `[0, n)`. `n` must be above zero.
    pub fn below(&mut self, n: u32) -> u32 {
        let hi = self.next_u64() >> 32;
        let pick = (hi * u64::from(n)) >> 32;
        u32::try_from(pick).expect("below n, and n fits 32 bits")
    }

    /// True in `per_1000` cases of 1,000.
    pub fn chance(&mut self, per_1000: u32) -> bool {
        self.below(1000) < per_1000
    }
}

/// splitmix64's output step. Also used to spread a seed into many streams.
#[must_use]
pub fn mix(x: u64) -> u64 {
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    use super::Rng;

    #[test]
    fn splitmix64_reference_values() {
        // The first outputs for seed 1234567, from the reference C code.
        let mut r = Rng::new(1_234_567);
        assert_eq!(r.next_u64(), 6_457_827_717_110_365_317);
        assert_eq!(r.next_u64(), 3_203_168_211_198_807_973);
        assert_eq!(r.next_u64(), 9_817_491_932_198_370_423);
    }

    #[test]
    fn below_stays_below() {
        let mut r = Rng::new(7);
        for n in [1u32, 2, 3, 10, 1000] {
            for _ in 0..1000 {
                assert!(r.below(n) < n);
            }
        }
    }
}
