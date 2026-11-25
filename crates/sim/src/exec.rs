//! The executive: the clock, the chaos, the order of steps and the trace.
//!
//! One tick, in this order:
//! 1. maybe crash one server for a while;
//! 2. maybe cut one server's links for a while;
//! 3. restart each server whose time down has ended;
//! 4. hand over each message that is due, in the order it was sent;
//! 5. maybe one client write;
//! 6. tick each live server.
//!
//! Every choice comes from the seed. Every step is hashed into the trace:
//! first the event, then what the world did because of it, then the fate of
//! each message it sent.

use crate::net::{Envelope, Net, MAX_DELAY};
use crate::num::ix;
use crate::rng::Rng;
use crate::trace::Trace;
use alloc::vec;
use alloc::vec::Vec;

/// The shape of the chaos. Chances are parts per 1,000 per tick.
#[derive(Clone, Copy, Debug)]
pub struct Chaos {
    /// How many ticks a seed runs.
    pub ticks: u32,
    pub crash_per_1000: u32,
    /// A crash lasts `crash_min` to `crash_min + crash_span - 1` ticks.
    pub crash_min: u32,
    pub crash_span: u32,
    pub cut_per_1000: u32,
    pub cut_min: u32,
    pub cut_span: u32,
    /// The chance that one message is lost.
    pub loss_per_1000: u32,
    /// A message takes `delay_min` to `delay_min + delay_span - 1` ticks.
    pub delay_min: u32,
    pub delay_span: u32,
    /// The chance of a client write in a tick.
    pub write_per_1000: u32,
}

impl Chaos {
    /// The shape probe P2 runs, after experiment E-04's: 130 ticks; 2 % to
    /// crash a server for 3 to 12 ticks; 2 % to cut a server's links for 5 to
    /// 14 ticks; 5 % loss; 1 to 3 ticks of delay; a write in 60 % of ticks.
    pub const P2: Chaos = Chaos {
        ticks: 130,
        crash_per_1000: 20,
        crash_min: 3,
        crash_span: 10,
        cut_per_1000: 20,
        cut_min: 5,
        cut_span: 10,
        loss_per_1000: 50,
        delay_min: 1,
        delay_span: 3,
        write_per_1000: 600,
    };

    /// No crash, no cut, no loss, one tick of delay, no client. For a short
    /// scripted scenario.
    pub const CALM: Chaos = Chaos {
        ticks: 0,
        crash_per_1000: 0,
        crash_min: 1,
        crash_span: 1,
        cut_per_1000: 0,
        cut_min: 1,
        cut_span: 1,
        loss_per_1000: 0,
        delay_min: 1,
        delay_span: 1,
        write_per_1000: 0,
    };
}

/// A message a world wants sent.
#[derive(Debug)]
struct Outgoing<M> {
    from: u32,
    to: u32,
    digest: u64,
    msg: M,
}

/// What a world writes to while it handles one event.
#[derive(Debug)]
pub struct Out<'a, M> {
    /// The trace. The world hashes its effects here, in a fixed order.
    pub trace: &'a mut Trace,
    outbox: &'a mut Vec<Outgoing<M>>,
    events: &'a mut u64,
}

impl<M> Out<'_, M> {
    /// Sends a message to another server. `digest` is the hash of its bytes.
    pub fn send(&mut self, from: u32, to: u32, digest: u64, msg: M) {
        self.outbox.push(Outgoing { from, to, digest, msg });
    }

    /// Counts one event: one call into one replica.
    pub fn event(&mut self) {
        *self.events += 1;
    }
}

/// What each simulated server runs.
pub trait World {
    /// A message between two servers. It never leaves the simulator.
    type Msg;

    /// How many servers there are.
    fn servers(&self) -> u32;
    /// Back to the first state, for this seed.
    fn reset(&mut self, seed: u64);
    /// One tick of the clock on one live server.
    fn tick(&mut self, server: u32, out: &mut Out<'_, Self::Msg>);
    /// A message arrives at a live server.
    fn deliver(&mut self, from: u32, to: u32, msg: Self::Msg, out: &mut Out<'_, Self::Msg>);
    /// One client write. The world draws what and where from `rng`.
    fn client(&mut self, rng: &mut Rng, out: &mut Out<'_, Self::Msg>);
    /// The server stops. It keeps only what it persisted.
    fn crash(&mut self, server: u32);
    /// The server starts again from what it persisted.
    fn restart(&mut self, server: u32, out: &mut Out<'_, Self::Msg>);
    /// Hashes the final state of every replica.
    fn dump(&self, trace: &mut Trace);
}

/// The result of one run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    /// Calls into replicas: ticks, messages, client writes, restarts.
    pub events: u64,
    /// The trace hash.
    pub hash: u64,
}

// The executive's own trace tags. A world uses tags from 0x20 up.
const T_SEED: u8 = 0x01;
const T_TICK: u8 = 0x02;
const T_CRASH: u8 = 0x03;
const T_CUT: u8 = 0x04;
const T_RESTART: u8 = 0x05;
const T_DELIVER: u8 = 0x06;
const T_UNDELIVERED: u8 = 0x07;
const T_SEND: u8 = 0x08;
const T_CLIENT: u8 = 0x09;
const T_SERVER_TICK: u8 = 0x0a;
const T_END: u8 = 0x0b;

/// The executive around one world.
#[derive(Debug)]
pub struct Exec<W: World> {
    world: W,
    chaos: Chaos,
    rng: Rng,
    net: Net<W::Msg>,
    trace: Trace,
    events: u64,
    now: u32,
    alive: Vec<bool>,
    down_until: Vec<u32>,
    outbox: Vec<Outgoing<W::Msg>>,
    due: Vec<Envelope<W::Msg>>,
}

impl<W: World> Exec<W> {
    #[must_use]
    pub fn new(world: W) -> Exec<W> {
        let n = world.servers();
        let alive = vec![true; ix(n)];
        let down_until = vec![0; ix(n)];
        Exec {
            world,
            chaos: Chaos::CALM,
            rng: Rng::new(0),
            net: Net::new(n),
            trace: Trace::new(),
            events: 0,
            now: 0,
            alive,
            down_until,
            outbox: Vec::new(),
            due: Vec::new(),
        }
    }

    #[must_use]
    pub fn world(&self) -> &W {
        &self.world
    }

    pub fn world_mut(&mut self) -> &mut W {
        &mut self.world
    }

    /// The tick about to run.
    #[must_use]
    pub fn now(&self) -> u32 {
        self.now
    }

    /// Resets everything in place and starts a run of `seed`.
    pub fn begin(&mut self, seed: u64, chaos: Chaos) {
        assert!(chaos.delay_min >= 1 && chaos.delay_min + chaos.delay_span - 1 <= MAX_DELAY, "delay out of range");
        self.chaos = chaos;
        self.rng = Rng::new(seed);
        self.net.reset();
        self.trace = Trace::new();
        self.events = 0;
        self.now = 0;
        for a in &mut self.alive {
            *a = true;
        }
        for d in &mut self.down_until {
            *d = 0;
        }
        self.outbox.clear();
        self.due.clear();
        self.world.reset(seed);
        self.trace.u8(T_SEED);
        self.trace.varint(seed);
    }

    /// Runs one tick.
    pub fn tick(&mut self) {
        let n = self.world.servers();
        let now = self.now;
        let c = self.chaos;
        self.trace.u8(T_TICK);
        self.trace.varint(u64::from(now));

        if self.rng.chance(c.crash_per_1000) {
            let s = self.rng.below(n);
            let until = now + c.crash_min + self.rng.below(c.crash_span);
            if self.alive[ix(s)] {
                self.alive[ix(s)] = false;
                self.down_until[ix(s)] = until;
                self.trace.u8(T_CRASH);
                self.trace.varint(u64::from(s));
                self.trace.varint(u64::from(until));
                self.world.crash(s);
            }
        }
        if self.rng.chance(c.cut_per_1000) {
            let s = self.rng.below(n);
            let until = now + c.cut_min + self.rng.below(c.cut_span);
            self.net.cut(s, until);
            self.trace.u8(T_CUT);
            self.trace.varint(u64::from(s));
            self.trace.varint(u64::from(until));
        }
        for s in 0..n {
            if !self.alive[ix(s)] && self.down_until[ix(s)] == now {
                self.alive[ix(s)] = true;
                self.trace.u8(T_RESTART);
                self.trace.varint(u64::from(s));
                self.act(|w, out| w.restart(s, out));
            }
        }

        let mut due = core::mem::take(&mut self.due);
        self.net.take_due(now, &mut due);
        for e in due.drain(..) {
            let open = self.alive[ix(e.to)] && !self.net.is_cut(e.to, now) && !self.net.is_cut(e.from, now);
            self.trace.u8(if open { T_DELIVER } else { T_UNDELIVERED });
            self.trace.varint(u64::from(e.from));
            self.trace.varint(u64::from(e.to));
            self.trace.u64(e.digest);
            if open {
                self.act(|w, out| w.deliver(e.from, e.to, e.msg, out));
            }
        }
        self.due = due;

        if self.rng.chance(c.write_per_1000) {
            self.trace.u8(T_CLIENT);
            let mut out = Out { trace: &mut self.trace, outbox: &mut self.outbox, events: &mut self.events };
            self.world.client(&mut self.rng, &mut out);
            self.flush();
        }
        for s in 0..n {
            if self.alive[ix(s)] {
                self.trace.u8(T_SERVER_TICK);
                self.trace.varint(u64::from(s));
                self.act(|w, out| w.tick(s, out));
            }
        }
        self.now = now + 1;
    }

    /// Runs one step of the world outside the tick's own order, then sends
    /// what it sent. A scripted scenario uses this for its client writes.
    pub fn act<R>(&mut self, f: impl FnOnce(&mut W, &mut Out<'_, W::Msg>) -> R) -> R {
        let mut out = Out { trace: &mut self.trace, outbox: &mut self.outbox, events: &mut self.events };
        let r = f(&mut self.world, &mut out);
        self.flush();
        r
    }

    /// Decides the fate of each message the last step sent: lost, or late by
    /// how many ticks.
    fn flush(&mut self) {
        let c = self.chaos;
        let mut outbox = core::mem::take(&mut self.outbox);
        for m in outbox.drain(..) {
            let lost = self.rng.chance(c.loss_per_1000);
            let delay = if lost { 0 } else { c.delay_min + self.rng.below(c.delay_span) };
            self.trace.u8(T_SEND);
            self.trace.varint(u64::from(m.from));
            self.trace.varint(u64::from(m.to));
            self.trace.u64(m.digest);
            self.trace.varint(u64::from(delay));
            if !lost {
                self.net.send(self.now, delay, Envelope { from: m.from, to: m.to, digest: m.digest, msg: m.msg });
            }
        }
        self.outbox = outbox;
    }

    /// Ends the run: hashes the final state of every replica.
    pub fn end(&mut self) -> Outcome {
        self.trace.u8(T_END);
        self.trace.varint(self.net.in_flight());
        for s in 0..self.world.servers() {
            self.trace.u8(u8::from(self.alive[ix(s)]));
        }
        self.world.dump(&mut self.trace);
        Outcome { events: self.events, hash: self.trace.value() }
    }

    /// Runs one seed whole.
    pub fn run_seed(&mut self, seed: u64, chaos: Chaos) -> Outcome {
        self.begin(seed, chaos);
        for _ in 0..chaos.ticks {
            self.tick();
        }
        self.end()
    }
}
