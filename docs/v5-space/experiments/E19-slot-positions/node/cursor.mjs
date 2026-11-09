// E-19 (Node): how big is a cursor over a whole resource, in each position form, and what does a
// reconnect storm of 10,000 clients cost in cursor bytes?
//
// A slot cursor (DESIGN-V5 §4.4): cluster id (16 B), the resource's incarnation (varint), then per slot
// its epoch and the sequence last seen. Slot moves carry a slot's sequence and epoch, so a move changes
// neither (DESIGN-V5 §4.2); only `fero recover --unclean` bumps the epochs of the slots it reopens.
// The program builds the per-slot (epoch, seq) vector a whole-resource reader would hold after a given
// history, runs the moves and recoveries on it, and encodes it six ways. Sizes are exact byte counts.
// The offset forms (CELL: 16 cells; LANE: 64 lanes; SPLIT: ranges that split) are encoded alongside.
//
// Usage: node cursor.mjs [secs=1]  -> one JSON line (sizes, then ns to encode and decode, which is light timing)
import zlib from 'node:zlib';
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const SECS = Number(args.secs || 1);
const SLOTS = 1024;

// ------------------------------------------------------------- slot hashing of partitions (as E-18: a 64-bit mix)
function mix(x) { x = BigInt.asUintN(64, x); x ^= x >> 33n; x = BigInt.asUintN(64, x * 0xff51afd7ed558ccdn); x ^= x >> 33n; x = BigInt.asUintN(64, x * 0xc4ceb9fe1a85ec53n); x ^= x >> 33n; return x; }
const slotOfPart = new Uint16Array(100000);
for (let i = 0; i < slotOfPart.length; i++) slotOfPart[i] = Number(mix(BigInt(i + 1)) % BigInt(SLOTS));

// expected writes per slot for N writes over P partitions with Zipf exponent s (s = 0: uniform)
function seqVector(N, s, P = 100000) {
  const w = new Float64Array(P); let tot = 0;
  for (let i = 0; i < P; i++) { w[i] = s === 0 ? 1 : 1 / Math.pow(i + 1, s); tot += w[i]; }
  const seq = new Float64Array(SLOTS);
  for (let i = 0; i < P; i++) seq[slotOfPart[i]] += (N * w[i]) / tot;
  return Array.from(seq, (x) => Math.round(x));
}

// ------------------------------------------------------------- encoders
class W { constructor() { this.b = Buffer.alloc(1 << 16); this.p = 0; }
  vu(v) { while (v >= 128) { this.b[this.p++] = (v % 128) | 128; v = Math.floor(v / 128); } this.b[this.p++] = v; }
  zz(v) { this.vu(v >= 0 ? 2 * v : -2 * v - 1); }
  u(n, bytes) { for (let i = 0; i < bytes; i++) { this.b[this.p++] = Number(BigInt(n) >> BigInt(8 * i) & 255n); } }
  raw(n) { this.p += n; }
  out() { return this.b.subarray(0, this.p); } }
const HEAD = (w) => { w.raw(16); w.vu(3); };   // cluster id + incarnation

// entries: [{slot, epoch, seq}] sorted by slot; `dense` forms assume all 1,024 slots are present
const ENC = {
  raw(ents) { const w = new W(); HEAD(w); w.vu(ents.length); for (const e of ents) { w.u(e.slot, 2); w.u(e.epoch, 4); w.u(e.seq, 8); } return w.out(); },
  varint(ents) { const w = new W(); HEAD(w); w.vu(ents.length); for (const e of ents) { w.vu(e.slot); w.vu(e.epoch); w.vu(e.seq); } return w.out(); },
  dense(ents) { const w = new W(); HEAD(w); w.vu(0); for (const e of ents) { w.vu(e.epoch); w.vu(e.seq); } return w.out(); },
  // epochs as runs (count, epoch); sequences zigzag-delta from the previous slot's
  delta(ents) { const w = new W(); HEAD(w); w.vu(0); let i = 0;
    while (i < ents.length) { let j = i; while (j < ents.length && ents[j].epoch === ents[i].epoch) j++; w.vu(j - i); w.vu(ents[i].epoch); i = j; }
    let prev = 0; for (const e of ents) { w.zz(e.seq - prev); prev = e.seq; } return w.out(); },
  // as delta, and runs of equal sequence deltas (for example untouched slots at 0) collapse to (0-marker, run length)
  rle(ents) { const w = new W(); HEAD(w); w.vu(0); let i = 0;
    while (i < ents.length) { let j = i; while (j < ents.length && ents[j].epoch === ents[i].epoch) j++; w.vu(j - i); w.vu(ents[i].epoch); i = j; }
    let prev = 0; i = 0;
    while (i < ents.length) { const d = ents[i].seq - prev; let j = i + 1, pv = ents[i].seq; while (j < ents.length && ents[j].seq - pv === d) { pv = ents[j].seq; j++; }
      if (j - i >= 3) { w.vu(0); w.vu(j - i); w.zz(d); } else { for (let k = i; k < j; k++) { const dd = ents[k].seq - (k === 0 ? 0 : ents[k - 1].seq); w.zz(dd); if (dd === 0) w.vu(1); } }
      prev = ents[j - 1].seq; i = j; }
    return w.out(); },
  deflate(ents) { return zlib.deflateRawSync(ENC.dense(ents), { level: 6 }); },
};
const FORMS = Object.keys(ENC);

// the varint size of a filtered cursor of k partitions (followed rooms), with their real sequences
function filtered(seq, k) { const ents = [], seen = new Set(); for (let i = 0; i < k; i++) { const s = slotOfPart[i * 997 % slotOfPart.length]; if (seen.has(s)) continue; seen.add(s); ents.push({ slot: s, epoch: 0, seq: seq[s] }); } ents.sort((a, b) => a.slot - b.slot); return ENC.varint(ents).length; }

// ------------------------------------------------------------- moves and recoveries on the slot vector
// groups own slots; a move hands one slot from one group to another; it carries (epoch, seq), so the cursor's
// vector is untouched. An unclean recovery of a group bumps the epoch of every slot that group holds.
function history(seqv, groups, moves, recoveries, seed) {
  let s = seed; const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  const owner = new Int32Array(SLOTS); for (let i = 0; i < SLOTS; i++) owner[i] = Math.floor(i * groups / SLOTS);   // contiguous at genesis
  const epoch = new Int32Array(SLOTS), seq = Float64Array.from(seqv);
  for (let m = 0; m < moves; m++) { const sl = Math.floor(rnd() * SLOTS); owner[sl] = Math.floor(rnd() * groups); }   // a move: owner changes, (epoch, seq) carried
  for (let r = 0; r < recoveries; r++) { const g = Math.floor(rnd() * groups); for (let i = 0; i < SLOTS; i++) if (owner[i] === g) epoch[i]++; }
  return Array.from({ length: SLOTS }, (_, i) => ({ slot: i, epoch: epoch[i], seq: seq[i] }));
}

const out = { exp: 'E-19', impl: 'node', part: 'cursor', node: process.version, loadavg: fs.readFileSync('/proc/loadavg', 'utf8').trim(), rows: [], offset_forms: [], filtered: [], storm: [], timing: [] };
const LOADS = [
  { name: 'young (1e3 writes)', N: 1e3, s: 0 },
  { name: 'uniform 1e6', N: 1e6, s: 0 },
  { name: 'uniform 1e9', N: 1e9, s: 0 },
  { name: 'zipf0.99 1e6', N: 1e6, s: 0.99 },
  { name: 'zipf0.99 1e9', N: 1e9, s: 0.99 },
  { name: 'zipf1.2 1e9', N: 1e9, s: 1.2 },
];
const HIST = [ { moves: 0, rec: 0 }, { moves: 10, rec: 0 }, { moves: 100, rec: 0 }, { moves: 100, rec: 1 }, { moves: 100, rec: 3 } ];
for (const L of LOADS) {
  const sv = seqVector(L.N, L.s);
  for (const H of HIST) {
    const ents = history(sv, 16, H.moves, H.rec, 12345);
    const row = { load: L.name, moves: H.moves, unclean_recoveries: H.rec };
    for (const f of FORMS) row[f] = ENC[f](ents).length;
    out.rows.push(row);
  }
  out.filtered.push({ load: L.name, k1: filtered(sv, 1), k10: filtered(sv, 10), k64: filtered(sv, 64), k1024parts: filtered(sv, 1024) });
}
// offset forms: CELL 16 cells, LANE 64 lanes, SPLIT n ranges after k splits; offsets ~ N / groups
for (const N of [1e6, 1e9]) {
  for (const [name, g] of [['CELL (16 cells)', 16], ['LANE (64 lanes)', 64]]) {
    const w = new W(); HEAD(w); w.vu(g); for (let i = 0; i < g; i++) w.vu(Math.round(N / g)); out.offset_forms.push({ form: name, N, after_moves: 'same size; a re-key makes every cursor unknown', bytes: w.out().length });
  }
  for (const k of [0, 10, 100]) {   // SPLIT: one range per split plus the first; each entry (range id, offset)
    const n = 1 + k; const w = new W(); HEAD(w); w.vu(n); for (let i = 0; i < n; i++) { w.vu(1000 + i); w.vu(Math.round(N / n)); } out.offset_forms.push({ form: 'SPLIT (ranges)', N, after_splits: k, bytes: w.out().length });
  }
}
// reconnect storm: 10,000 clients at once
const worst = (f) => Math.max(...out.rows.map((r) => r[f]));
const typicalWhole = (f) => out.rows.find((r) => r.load === 'zipf0.99 1e9' && r.moves === 100 && r.unclean_recoveries === 0)[f];
for (const f of FORMS) {
  out.storm.push({ form: f, all_whole_resource_typical_MB: +(10000 * typicalWhole(f) / 1e6).toFixed(2), all_whole_resource_worst_MB: +(10000 * worst(f) / 1e6).toFixed(2) });
}
const fz = out.filtered.find((x) => x.load === 'zipf0.99 1e9');
out.storm.push({ form: 'mix: 9,936 clients x 10 rooms (varint) + 64 relays x whole resource (delta)', MB: +((9936 * fz.k10 + 64 * typicalWhole('delta')) / 1e6).toFixed(3) });

// light timing: ns to encode and decode (parse) one whole-resource cursor in the delta form
{
  const ents = history(seqVector(1e9, 0.99), 16, 100, 0, 12345);
  let t0 = process.hrtime.bigint(), it = 0; while (Number(process.hrtime.bigint() - t0) < SECS * 1e9) { for (let k = 0; k < 100; k++) ENC.delta(ents); it += 100; }
  const encUs = Number(process.hrtime.bigint() - t0) / it / 1000;
  const buf = Buffer.from(ENC.delta(ents)); let sink = 0;
  const dec = (b) => { let q = 17; const rv = () => { let v = 0, mul = 1, x; do { x = b[q++]; v += (x & 127) * mul; mul *= 128; } while (x & 128); return v; };
    rv(); let n = 0; const ep = new Int32Array(SLOTS); while (n < SLOTS) { const c = rv(), e = rv(); ep.fill(e, n, n + c); n += c; }
    const sq = new Float64Array(SLOTS); let prev = 0; for (let i = 0; i < SLOTS; i++) { const z = rv(); prev += (z & 1) ? -(z + 1) / 2 : z / 2; sq[i] = prev; } return sq[SLOTS - 1] + ep[0]; };
  if (dec(buf) !== ents[SLOTS - 1].seq) throw new Error('cursor decode mismatch');
  t0 = process.hrtime.bigint(); it = 0; while (Number(process.hrtime.bigint() - t0) < SECS * 1e9) { for (let k = 0; k < 100; k++) sink += dec(buf); it += 100; }
  const decUs = Number(process.hrtime.bigint() - t0) / it / 1000;
  out.timing.push({ what: 'whole-resource cursor, delta form, zipf0.99 1e9', bytes: buf.length, encode_us: +encUs.toFixed(2), decode_us: +decUs.toFixed(2), sink: sink % 7 });
}
console.log(JSON.stringify(out));
