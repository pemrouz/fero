// Licensed under the Apache License, Version 2.0.

//! The marker's own test. Run it both ways:
//!
//!     cargo test --release -p rule
//!     cargo test --release -p rule --features switch

use rule::rule;

/// A tiny machine with three marked rules, one of each form.
fn run(limit: u64) -> (u64, u64) {
    let mut count = 0;
    let mut sum = 0;
    for i in 0..10 {
        // A guard: off lets everything through.
        if rule!("test.guard", i >= limit, off = false) {
            continue;
        }
        // A block: off skips it.
        rule!("test.block", {
            count += 1;
        });
        // A value: off gives the plain value.
        sum += rule!("test.value", i * 2, off = i);
    }
    (count, sum)
}

#[test]
fn hash_is_fnv1a() {
    // The standard FNV-1a test vectors.
    assert_eq!(rule::hash(""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(rule::hash("a"), 0xaf63_dc4c_8601_ec8c);
    assert_eq!(rule::hash("foobar"), 0x8594_4171_f739_67e8);
}

#[cfg(not(feature = "switch"))]
#[test]
fn a_normal_build_is_the_block() {
    assert_eq!(run(4), (4, 12));
}

/// One test, because the switch is one process-wide number.
#[cfg(feature = "switch")]
#[test]
fn each_form_switches_off_and_back_on() {
    rule::switch_all_on();
    assert_eq!(run(4), (4, 12));
    rule::switch_off("test.guard");
    assert_eq!(run(4), (10, 90));
    rule::switch_off("test.block");
    assert_eq!(run(4), (0, 12));
    rule::switch_off("test.value");
    assert_eq!(run(4), (4, 6));
    rule::switch_off("test.none-such");
    assert_eq!(run(4), (4, 12));
    rule::switch_all_on();
    assert_eq!(run(4), (4, 12));
}
