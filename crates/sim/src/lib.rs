//! The simulation executive.
//!
//! A run is a function of its seed. The executive owns the seeded generator,
//! the clock in logical ticks, the fake network, the crashes and the trace.
//! A **world** is what each simulated server runs; it plugs in through the
//! [`exec::World`] trait.
//!
//! Two parts, kept apart:
//! - the executive: [`rng`], [`trace`], [`net`], [`exec`]. It knows nothing
//!   about Raft.
//! - the probe P2 world: [`payload`], [`p2`]. Three servers, two Raft groups,
//!   each replica the ported `raft::RawNode`. The real kernel replaces it in
//!   slice 1.
//!
//! Rules this crate keeps: no `std`, no `unsafe`, no outside crates, no hashed
//! containers, no floats, and no machine-sized integer outside [`num`]. The
//! WASM build is 32-bit and the native build is 64-bit; both must give the
//! same bytes.

#![no_std]

extern crate alloc;

pub mod exec;
pub mod net;
pub mod num;
pub mod p2;
pub mod payload;
pub mod rng;
pub mod trace;
