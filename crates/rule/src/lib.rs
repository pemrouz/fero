// Licensed under the Apache License, Version 2.0.

//! The rule marker.
//!
//! A **rule** is one record of the ledger (`spec/ledger.json`). The code that
//! holds a rule is wrapped in `rule!` with the rule's id, so a scan can list
//! where each rule lives and a test run can switch one rule off.
//!
//! Two forms:
//!
//! ```ignore
//! // A block that returns nothing. Switched off, the block does not run.
//! rule!("raft-term-vote.5", {
//!     self.vote = self.id;
//! });
//!
//! // An expression with a value. Switched off, the `off` expression is the
//! // value and the first expression is not run.
//! if rule!("raft-log.5", !self.match_term(prev), off = false) {
//!     return None;
//! }
//! let commit = rule!("raft-commit.7", min(matched, committed), off = committed);
//! ```
//!
//! So "switched off" always means the same thing: the marked code is not run,
//! and the stated `off` value stands in for it. A block has no value, so its
//! `off` is nothing. A guard's `off` is the answer that lets everything through.
//! A value's `off` is the plain value the rule was shaping.
//!
//! **Cost.** Without the `switch` feature the macro IS its first expression:
//! the id and the `off` expression are dropped while the macro expands, before
//! the compiler sees them. With `switch` each marker is one load and one
//! compare of a 64-bit number.
//!
//! **Switching.** The id is hashed while compiling (FNV-1a, 64 bits). One
//! atomic holds the hash of the rule that is off; 0 means none.
//! `rule::switch_off("id")` sets it. With `switch-env` the first marker reached
//! reads the id from the `RULE_OFF` environment variable, and if
//! `RULE_HIT_FILE` is set, the first time the switched-off marker is reached
//! an empty file of that name is made (so a runner can tell "no test reaches
//! this rule" from "tests reach it and stay green").
//!
//! `tools/rule-scan.mjs` checks that no two ledger ids share a hash.

#![cfg_attr(not(feature = "switch-env"), no_std)]

/// FNV-1a over the id's bytes, 64 bits. Runs while compiling.
#[must_use]
pub const fn hash(id: &str) -> u64 {
    let b = id.as_bytes();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut i = 0;
    while i < b.len() {
        h ^= b[i] as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
        i += 1;
    }
    // 0 means "no rule is off" and all ones means "not read yet".
    if h == 0 || h == u64::MAX {
        1
    } else {
        h
    }
}

#[cfg(feature = "switch")]
mod switch {
    use core::sync::atomic::{AtomicU64, Ordering};

    /// The hash of the rule that is off. 0: none. All ones: not read yet.
    static OFF: AtomicU64 = AtomicU64::new(START);

    #[cfg(feature = "switch-env")]
    const START: u64 = u64::MAX;
    #[cfg(not(feature = "switch-env"))]
    const START: u64 = 0;

    /// Switches one rule off, by id. It stays off until `switch_all_on`.
    pub fn switch_off(id: &str) {
        OFF.store(super::hash(id), Ordering::Relaxed);
    }

    /// Switches every rule back on.
    pub fn switch_all_on() {
        OFF.store(0, Ordering::Relaxed);
    }

    /// True when the rule with this hash should run. The macro calls it.
    #[doc(hidden)]
    #[inline]
    #[must_use]
    pub fn on(h: u64) -> bool {
        let off = OFF.load(Ordering::Relaxed);
        if off == 0 {
            return true;
        }
        slow(h, off)
    }

    #[cfg(not(feature = "switch-env"))]
    fn slow(h: u64, off: u64) -> bool {
        off != h
    }

    #[cfg(feature = "switch-env")]
    #[cold]
    fn slow(h: u64, mut off: u64) -> bool {
        if off == u64::MAX {
            off = std::env::var("RULE_OFF").map_or(0, |id| if id.is_empty() { 0 } else { super::hash(&id) });
            OFF.store(off, Ordering::Relaxed);
        }
        if off != h {
            return true;
        }
        static HIT: core::sync::atomic::AtomicBool = core::sync::atomic::AtomicBool::new(false);
        if !HIT.swap(true, Ordering::Relaxed) {
            if let Some(path) = std::env::var_os("RULE_HIT_FILE") {
                // A marker file for the test runner; a failure to write it changes nothing.
                let _ = std::fs::File::create(path);
            }
        }
        false
    }
}

#[cfg(feature = "switch")]
pub use switch::{on, switch_all_on, switch_off};

/// Wraps the code that holds one ledger rule. See the crate's page.
#[cfg(not(feature = "switch"))]
#[macro_export]
macro_rules! rule {
    ($id:literal, $body:block) => {
        $body
    };
    ($id:literal, $body:expr, off = $off:expr) => {
        $body
    };
}

/// Wraps the code that holds one ledger rule. See the crate's page.
#[cfg(feature = "switch")]
#[macro_export]
macro_rules! rule {
    ($id:literal, $body:block) => {{
        const RULE_HASH: u64 = $crate::hash($id);
        if $crate::on(RULE_HASH) $body
    }};
    ($id:literal, $body:expr, off = $off:expr) => {{
        const RULE_HASH: u64 = $crate::hash($id);
        if $crate::on(RULE_HASH) {
            $body
        } else {
            $off
        }
    }};
}
