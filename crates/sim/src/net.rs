//! The fake network: late messages and cut links.
//!
//! A message waits in the slot of the tick it is due. The executive looks at
//! the cuts when a message is due, not when it is sent: it drops the message
//! if the sender's or the receiver's links are cut at that tick. So a message
//! sent in the last ticks of a cut can still arrive after the cut ends. A new
//! cut of a server replaces its old one, even a longer one. Loss and the size
//! of a delay are drawn by the executive; this file only stores and hands
//! back.

use crate::num::ix;
use alloc::vec;
use alloc::vec::Vec;

/// The longest delay the ring can hold, in ticks.
pub const MAX_DELAY: u32 = 3;
const SLOTS: u32 = MAX_DELAY + 1;

/// One message on its way.
#[derive(Debug)]
pub struct Envelope<M> {
    pub from: u32,
    pub to: u32,
    /// The hash of the message's bytes, taken when it was sent.
    pub digest: u64,
    pub msg: M,
}

/// The network between the simulated servers.
#[derive(Debug)]
pub struct Net<M> {
    /// Slot `t % SLOTS` holds what is due at tick `t`.
    ring: Vec<Vec<Envelope<M>>>,
    /// A server's links are cut while `cut_until > now`.
    cut_until: Vec<u32>,
}

impl<M> Net<M> {
    #[must_use]
    pub fn new(servers: u32) -> Net<M> {
        let mut ring = Vec::new();
        for _ in 0..SLOTS {
            ring.push(Vec::new());
        }
        Net { ring, cut_until: vec![0; ix(servers)] }
    }

    /// Empties the network. Keeps its buffers.
    pub fn reset(&mut self) {
        for slot in &mut self.ring {
            slot.clear();
        }
        for c in &mut self.cut_until {
            *c = 0;
        }
    }

    /// Queues a message for the tick `now + delay`.
    pub fn send(&mut self, now: u32, delay: u32, e: Envelope<M>) {
        assert!((1..=MAX_DELAY).contains(&delay), "delay {delay} is outside 1..={MAX_DELAY}");
        self.ring[ix((now + delay) % SLOTS)].push(e);
    }

    /// Moves what is due at `now` into `due`, in the order it was sent.
    /// `due` must be empty; the two buffers swap, so neither is freed.
    pub fn take_due(&mut self, now: u32, due: &mut Vec<Envelope<M>>) {
        debug_assert!(due.is_empty());
        core::mem::swap(&mut self.ring[ix(now % SLOTS)], due);
    }

    /// Cuts a server's links until the tick `until`.
    pub fn cut(&mut self, server: u32, until: u32) {
        self.cut_until[ix(server)] = until;
    }

    /// True while the server's links are cut.
    #[must_use]
    pub fn is_cut(&self, server: u32, now: u32) -> bool {
        self.cut_until[ix(server)] > now
    }

    /// How many messages are still on their way.
    #[must_use]
    pub fn in_flight(&self) -> u64 {
        let mut n = 0;
        for slot in &self.ring {
            n += crate::num::len64(slot);
        }
        n
    }
}
