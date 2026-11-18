// E-54 in Rust: one persistent-map root kept per version (im 15.1.0 and imbl 7.0.2, both HAMTs; rpds 1.2.1's
// HashTrieMap), against a plain std HashMap fold and a HashMap plus reverse records. Rows are Arc'd and never
// changed: a field write makes a new row that shares every other field, as data's rows do. The log is the same
// seeded tape as bench/common.mjs (same generator, same mix). A counting allocator gives exact bytes.
//   e54 <rows> <way: base | rev | im | imbl | rpds> [history]
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::sync::Arc;
use std::time::Instant;

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { LIVE.fetch_add(l.size(), Relaxed); TOTAL.fetch_add(l.size(), Relaxed); System.alloc(l) }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { LIVE.fetch_sub(l.size(), Relaxed); System.dealloc(p, l) }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        LIVE.fetch_add(n, Relaxed); LIVE.fetch_sub(l.size(), Relaxed); TOTAL.fetch_add(n, Relaxed); System.realloc(p, l, n)
    }
}
#[global_allocator]
static A: Counting = Counting;

#[derive(Clone)]
struct Row { name: Arc<str>, email: Arc<str>, region: Arc<str>, room: u32, n: u64, active: bool, tags: Arc<[Arc<str>]> }
type R = Arc<Row>;
enum Kind { Field(u64), Whole(R), Insert(R), Remove }
struct Rec { key: Arc<str>, kind: Kind }

fn row(i: u32, s: u64, a: &Arc<str>, b: &Arc<str>) -> R {
    Arc::new(Row { name: format!("user-{i}").into(), email: format!("u{i}.example.com").into(), region: format!("r{}", i % 16).into(), room: i % 100, n: s, active: i & 1 == 0, tags: Arc::from(vec![a.clone(), b.clone()]) })
}
fn key(i: u32) -> Arc<str> { format!("k{i}").into() }

struct Rng(u32);
impl Rng { fn next(&mut self) -> u32 { self.0 = self.0.wrapping_mul(1103515245).wrapping_add(12345) & 0x7fffffff; self.0 } }

// the same tape as common.mjs: 45% field writes, 45% whole-row writes, 5% new rows, 5% removes
fn tape(n: u32, t: usize, a: &Arc<str>, b: &Arc<str>) -> (Vec<Rec>, u32) {
    let mut r = Rng(54);
    let mut live: Vec<u32> = (0..n).collect();
    let (mut next, mut s) = (n, 1u64);
    let mut recs = Vec::with_capacity(t);
    for _ in 0..t {
        let m = r.next() % 100;
        if m < 45 { let j = live[(r.next() as usize) % live.len()]; s += 1; recs.push(Rec { key: key(j), kind: Kind::Field(s) }) }
        else if m < 90 { let j = live[(r.next() as usize) % live.len()]; s += 1; recs.push(Rec { key: key(j), kind: Kind::Whole(row(j, s, a, b)) }) }
        else if m < 95 { let j = next; next += 1; live.push(j); s += 1; recs.push(Rec { key: key(j), kind: Kind::Insert(row(j, s, a, b)) }) }
        else { let x = (r.next() as usize) % live.len(); let j = live.swap_remove(x); recs.push(Rec { key: key(j), kind: Kind::Remove }) }
    }
    (recs, next)
}

fn apply_row(old: Option<&R>, k: &Kind) -> Option<R> {
    match k {
        Kind::Field(v) => Some(Arc::new(Row { n: *v, ..(**old.expect("field write to a live row")).clone() })),
        Kind::Whole(r) | Kind::Insert(r) => Some(r.clone()),
        Kind::Remove => None,
    }
}
fn same(a: Option<&R>, b: Option<&R>) -> bool {
    match (a, b) { (None, None) => true, (Some(x), Some(y)) => x.name == y.name && x.n == y.n && x.room == y.room && x.tags.len() == y.tags.len(), _ => false }
}

// every way: build the history, then reads at a version, a picture into a std HashMap
trait Way {
    fn write(&mut self, i: usize, x: &Rec);
    fn read(&self, v: usize, k: &str) -> Option<R>;
    fn picture(&self, v: usize) -> HashMap<Arc<str>, R>;
}

struct Base { m: HashMap<Arc<str>, R> }
impl Way for Base {
    fn write(&mut self, _i: usize, x: &Rec) { match apply_row(self.m.get(&*x.key), &x.kind) { Some(r) => { self.m.insert(x.key.clone(), r); } None => { self.m.remove(&*x.key); } } }
    fn read(&self, _v: usize, k: &str) -> Option<R> { self.m.get(k).cloned() } // the newest version only
    fn picture(&self, _v: usize) -> HashMap<Arc<str>, R> { self.m.clone() }
}
struct Rev { m: HashMap<Arc<str>, R>, prev: Vec<Option<R>> }
impl Way for Rev {
    fn write(&mut self, _i: usize, x: &Rec) {
        let old = self.m.get(&*x.key).cloned();
        let nr = apply_row(old.as_ref(), &x.kind);
        self.prev.push(old);
        match nr { Some(r) => { self.m.insert(x.key.clone(), r); } None => { self.m.remove(&*x.key); } }
    }
    fn read(&self, _v: usize, k: &str) -> Option<R> { self.m.get(k).cloned() }
    fn picture(&self, _v: usize) -> HashMap<Arc<str>, R> { self.m.clone() }
}
macro_rules! persistent {
    ($name:ident, $map:ty, $set:ident, $del:ident) => {
        struct $name { v: Vec<$map> }
        impl Way for $name {
            fn write(&mut self, i: usize, x: &Rec) {
                let m = &self.v[i];
                let nm = match apply_row(m.get(&*x.key), &x.kind) { Some(r) => m.$set(x.key.clone(), r), None => m.$del(&*x.key) };
                self.v.push(nm);
            }
            fn read(&self, v: usize, k: &str) -> Option<R> { self.v[v].get(k).cloned() }
            fn picture(&self, v: usize) -> HashMap<Arc<str>, R> {
                let m = &self.v[v];
                let mut o = HashMap::with_capacity(m.size());
                for (k, r) in m.iter() { o.insert(k.clone(), r.clone()); }
                o
            }
        }
    };
}
trait Size { fn size(&self) -> usize; }
impl Size for im::HashMap<Arc<str>, R> { fn size(&self) -> usize { self.len() } }
impl Size for imbl::HashMap<Arc<str>, R> { fn size(&self) -> usize { self.len() } }
impl Size for rpds::HashTrieMapSync<Arc<str>, R> { fn size(&self) -> usize { self.size() } }
persistent!(Im, im::HashMap<Arc<str>, R>, update, without);
persistent!(Imbl, imbl::HashMap<Arc<str>, R>, update, without);
persistent!(Rpds, rpds::HashTrieMapSync<Arc<str>, R>, insert, remove);

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: u32 = args[1].parse().unwrap();
    let way = args[2].as_str();
    let h: usize = args.get(3).map(|s| s.parse().unwrap()).unwrap_or(1_000_000);
    let (ta, tb): (Arc<str>, Arc<str>) = ("a".into(), "b".into());
    let (recs, keys_ever) = tape(n, h, &ta, &tb);
    let init: Vec<(Arc<str>, R)> = (0..n).map(|i| (key(i), row(i, 0, &ta, &tb))).collect();

    let t0 = Instant::now();
    let mut w: Box<dyn Way> = match way {
        "base" => Box::new(Base { m: init.iter().cloned().collect() }),
        "rev" => Box::new(Rev { m: init.iter().cloned().collect(), prev: Vec::new() }),
        "im" => { let mut m = im::HashMap::new(); for (k, r) in &init { m.insert(k.clone(), r.clone()); } Box::new(Im { v: vec![m] }) }
        "imbl" => { let mut m = imbl::HashMap::new(); for (k, r) in &init { m.insert(k.clone(), r.clone()); } Box::new(Imbl { v: vec![m] }) }
        "rpds" => { let mut m = rpds::HashTrieMapSync::new_sync(); for (k, r) in &init { m.insert_mut(k.clone(), r.clone()); } Box::new(Rpds { v: vec![m] }) }
        _ => panic!("way: base | rev | im | imbl | rpds"),
    };
    let init_ms = t0.elapsed().as_secs_f64() * 1e3;

    // build: H writes, history kept
    let (l0, a0) = (LIVE.load(Relaxed), TOTAL.load(Relaxed));
    let t1 = Instant::now();
    for (i, x) in recs.iter().enumerate() { w.write(i, x); }
    let build_ns = t1.elapsed().as_nanos() as f64 / h as f64;
    let (l1, a1) = (LIVE.load(Relaxed), TOTAL.load(Relaxed));
    let kept = (l1 as f64 - l0 as f64) / h as f64;
    let alloc = (a1 - a0) as f64 / h as f64;

    // reads at random versions (persistent ways) or at the newest version (base, rev), 100,000 in one batch
    let mut r = Rng(n.wrapping_add(7));
    let picks: Vec<(usize, String)> = (0..100_000).map(|_| ((r.next() as usize) % (h + 1), format!("k{}", r.next() % keys_ever))).collect();
    let persistent = matches!(way, "im" | "imbl" | "rpds");
    let t2 = Instant::now();
    let mut found = 0usize;
    for (v, k) in &picks { if w.read(if persistent { *v } else { h }, k).is_some() { found += 1; } }
    let read_ns = t2.elapsed().as_nanos() as f64 / picks.len() as f64;

    // a whole picture as a std HashMap, 3 samples
    let mut pic_ms = Vec::new();
    for j in 0..3 { let v = if persistent { picks[j].0 } else { h }; let t = Instant::now(); let p = w.picture(v); pic_ms.push(t.elapsed().as_secs_f64() * 1e3); std::hint::black_box(p.len()); }
    pic_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());

    // checks: reads at 14 versions for 40 keys against a refold from the start
    let (mut checked, mut wrong) = (0, 0);
    if persistent {
        let mut cr = Rng(99);
        let mut cvs: Vec<usize> = vec![0, h]; for _ in 0..12 { cvs.push((cr.next() as usize) % (h + 1)); } cvs.sort();
        let cks: Vec<String> = (0..40).map(|_| format!("k{}", cr.next() % keys_ever)).collect();
        let mut m: HashMap<Arc<str>, R> = init.iter().cloned().collect();
        let mut ci = 0;
        for v in 0..=h {
            while ci < cvs.len() && cvs[ci] == v { for k in &cks { checked += 1; if !same(m.get(k.as_str()), w.read(v, k).as_ref()) { wrong += 1; } } ci += 1; }
            if v < h { let x = &recs[v]; match apply_row(m.get(&*x.key), &x.kind) { Some(nr) => { m.insert(x.key.clone(), nr); } None => { m.remove(&*x.key); } } }
        }
    }
    println!("{{\"exp\":\"E-54\",\"part\":\"rust\",\"way\":\"{way}\",\"rows\":{n},\"history\":{h},\"init_ms\":{init_ms:.1},\"ns_per_write\":{build_ns:.1},\"kept_b_per_version\":{kept:.1},\"alloc_b_per_write\":{alloc:.1},\"kept_mb\":{:.1},\"read_ns\":{read_ns:.1},\"read_found\":{found},\"picture_ms\":{:.1},\"checked\":{checked},\"wrong\":{wrong}}}", (l1 as f64 - l0 as f64) / 1048576.0, pic_ms[1]);
}
