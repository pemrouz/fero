//! The simulator as a WASM module, for Node.
//!
//! One instance is made once and used for every seed. The world resets
//! inside it. Messages between the simulated servers stay on this side.
//! JavaScript is called once per batch of committed entries, never once per
//! message.
//!
//! The ABI is plain numbers and one view of bytes. A 64-bit number crosses as
//! two 32-bit halves, low half first.
//!
//! Import, module `fero`:
//! - `batch(server, group, first_lo, first_hi, ptr, len)`: one batch of
//!   committed entries of one replica. The bytes at `ptr` are valid only
//!   during the call. Their shape is in `sim::p2::BatchSink`. The import
//!   returns nothing, so nothing JavaScript does can change a run.
//!
//! Exports:
//! - `p2_reset(seed_lo, seed_hi)`: a new world for this seed, in place.
//! - `p2_run_seed(seed_lo, seed_hi) -> events`: resets, then runs the seed
//!   whole under the chaos of probe P2.
//! - `p2_fresh(seed_lo, seed_hi) -> events`: resets, then runs the
//!   fresh-world scenario.
//! - `p2_destroy()`: drops every replica.
//! - `p2_hash_lo()`, `p2_hash_hi()`: the trace hash of the last run.
//! - `p2_panic_ptr()`, `p2_panic_len()`: the message of a panic, as UTF-8. A
//!   monitor that fails panics; the call traps; the message says why.
//!
//! `unsafe` here is only what an export and an import need. Each use says
//! why it is sound.

use sim::exec::{Chaos, Exec, Outcome};
use sim::p2::{fresh, BatchSink, P2World};
use std::cell::{Cell, RefCell};

#[cfg(target_arch = "wasm32")]
mod host {
    // SAFETY: the host must provide `fero.batch` with this signature; the
    // module does not start without it. Every argument is a plain number, so
    // the call itself cannot break memory safety: it is declared `safe`.
    #[allow(unsafe_code)]
    #[link(wasm_import_module = "fero")]
    unsafe extern "C" {
        pub safe fn batch(server: u32, group: u32, first_lo: u32, first_hi: u32, ptr: *const u8, len: u32);
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod host {
    /// A native build of this crate has no host. It exists so the usual
    /// checks can read the crate.
    pub fn batch(_server: u32, _group: u32, _first_lo: u32, _first_hi: u32, _ptr: *const u8, _len: u32) {}
}

fn halves(v: u64) -> (u32, u32) {
    let b = v.to_le_bytes();
    (u32::from_le_bytes([b[0], b[1], b[2], b[3]]), u32::from_le_bytes([b[4], b[5], b[6], b[7]]))
}

fn whole(lo: u32, hi: u32) -> u64 {
    (u64::from(hi) << 32) | u64::from(lo)
}

/// Hands each batch to JavaScript.
#[derive(Debug)]
struct HostSink;

impl BatchSink for HostSink {
    const ACTIVE: bool = true;
    fn batch(&mut self, server: u32, group: u32, first_index: u64, bytes: &[u8]) {
        let (lo, hi) = halves(first_index);
        let len = u32::try_from(bytes.len()).expect("a batch fits 32 bits");
        host::batch(server, group, lo, hi, bytes.as_ptr(), len);
    }
}

thread_local! {
    /// The one simulator of this instance.
    static SIM: RefCell<Exec<P2World<HostSink>>> = RefCell::new(Exec::new(P2World::new(HostSink)));
    /// The result of the last run.
    static LAST: Cell<Outcome> = const { Cell::new(Outcome { events: 0, hash: 0 }) };
    /// The message of the last panic.
    static PANIC: RefCell<String> = const { RefCell::new(String::new()) };
    static HOOKED: Cell<bool> = const { Cell::new(false) };
}

/// Keeps a panic's message where JavaScript can read it after the trap.
fn hook_panics() {
    if !HOOKED.replace(true) {
        std::panic::set_hook(Box::new(|info| {
            let text = info.to_string();
            PANIC.with(|p| {
                if let Ok(mut p) = p.try_borrow_mut() {
                    *p = text;
                }
            });
        }));
    }
}

fn events_u32(o: Outcome) -> u32 {
    LAST.set(o);
    u32::try_from(o.events).expect("the event count fits 32 bits")
}

// Why each export below is sound: `no_mangle` gives the function a fixed
// symbol name, which is `unsafe` only because two symbols of one name would
// clash. The names here start with `p2_`, and no other symbol of the module
// does. Each function takes and returns plain numbers only.

/// A new world for this seed, in place.
// SAFETY: the name `p2_reset` is unique in the module; see the note above.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn p2_reset(seed_lo: u32, seed_hi: u32) {
    hook_panics();
    SIM.with_borrow_mut(|sim| sim.begin(whole(seed_lo, seed_hi), Chaos::P2));
}

/// Resets, then runs one seed whole. Returns the number of events.
// SAFETY: the name `p2_run_seed` is unique in the module; see the note above.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn p2_run_seed(seed_lo: u32, seed_hi: u32) -> u32 {
    hook_panics();
    events_u32(SIM.with_borrow_mut(|sim| sim.run_seed(whole(seed_lo, seed_hi), Chaos::P2)))
}

/// Resets, then runs the fresh-world scenario. Returns the number of events.
// SAFETY: the name `p2_fresh` is unique in the module; see the note above.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn p2_fresh(seed_lo: u32, seed_hi: u32) -> u32 {
    hook_panics();
    events_u32(SIM.with_borrow_mut(|sim| fresh(sim, whole(seed_lo, seed_hi))))
}

/// Drops every replica.
// SAFETY: the name `p2_destroy` is unique in the module; see the note above.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn p2_destroy() {
    SIM.with_borrow_mut(|sim| sim.world_mut().destroy());
}

/// The low half of the last run's trace hash.
// SAFETY: the name `p2_hash_lo` is unique in the module; see the note above.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn p2_hash_lo() -> u32 {
    halves(LAST.get().hash).0
}

/// The high half of the last run's trace hash.
// SAFETY: the name `p2_hash_hi` is unique in the module; see the note above.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn p2_hash_hi() -> u32 {
    halves(LAST.get().hash).1
}

/// Where the last panic's message starts.
// SAFETY: the name `p2_panic_ptr` is unique in the module; see the note above.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn p2_panic_ptr() -> *const u8 {
    PANIC.with_borrow(|p| p.as_ptr())
}

/// How many bytes the last panic's message has.
// SAFETY: the name `p2_panic_len` is unique in the module; see the note above.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn p2_panic_len() -> u32 {
    PANIC.with_borrow(|p| u32::try_from(p.len()).expect("a message fits 32 bits"))
}
