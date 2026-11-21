// E-62 shared helpers: E-05's small row, a seeded generator, the interleaved timer, varints, and the text forms of a
// version and a cursor (E-56 positions' forms, built without BigInt and checked against E-56's BigInt form).
import { readFileSync } from 'node:fs'

export const row = (i, s = i) => ({ name: 'user-' + i, email: 'u' + i + '.example.com', region: 'r' + (i % 16), room: i % 100, n: s, active: (i & 1) === 0, tags: ['a', 'b'] })
export const key = (i) => 'k' + i
export const seedRows = (n) => { const o = {}; for (let i = 0; i < n; i++) o[key(i)] = row(i); return o }
export const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc() } }
export const now = () => process.hrtime.bigint()
export const heap = () => { gc(); return process.memoryUsage().heapUsed }
export const loadavg = () => { try { return readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ') } catch { return '' } }
// Is the process alone on the box? The CPU time the whole box spent busy (from /proc/stat) over this process's life,
// minus this process's own CPU time (every thread: the GC's helpers too). What is left ran in other processes.
const busyTicks = () => { try { const f = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number); return { busy: f[0] + f[1] + f[2] + f[5] + f[6], steal: f[7] ?? 0 } } catch { return null } }
const START = { t: process.hrtime.bigint(), ticks: busyTicks(), own: process.cpuUsage(), load: loadavg() }
export function box() {
  const t = busyTicks(), own = process.cpuUsage(START.own), wall = Number(process.hrtime.bigint() - START.t) / 1e9
  const ownS = (own.user + own.system) / 1e6
  const r2 = (x) => Math.round(x * 100) / 100
  if (t === null || START.ticks === null) return { wall_s: r2(wall), own_cpu_s: r2(ownS), load_start: START.load, load_end: loadavg() }
  const busyS = (t.busy - START.ticks.busy) / 100 // USER_HZ is 100 on Linux
  return { wall_s: r2(wall), own_cpu_s: r2(ownS), others_cpu_s: r2(Math.max(0, busyS - ownS)), steal_s: r2((t.steal - START.ticks.steal) / 100), load_start: START.load, load_end: loadavg() }
}
export const out = (o) => process.stdout.write(JSON.stringify({ exp: 'E-62', node: process.version, loadavg: loadavg(), box: box(), ...o }) + '\n')
// A string built by `+` past 12 characters is a rope; reading a character makes it one flat string, which whoever uses
// the text (sends it, saves it, compares it) pays anyway. The read goes to a sink so it is not optimized away.
let flatSink = 0
export const flat = (s) => { flatSink = (flatSink + s.charCodeAt(s.length - 1)) & 1023; return s }
export const flatSinkUsed = () => flatSink >= 0
export const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
export const r1 = (x) => Math.round(x * 10) / 10
export const r3 = (x) => Math.round(x * 1000) / 1000
export const stat = (v) => { const s = [...v].sort((a, b) => a - b); return { med: r1(med(v)), lo: r1(s[0]), hi: r1(s[s.length - 1]) } }

// a seeded PRNG (mulberry32, as E-56 positions), so every run picks the same keys
export const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// E-55 claim 10's interleaved timer (review F5): every way is made up front; each round runs every way once, the
// order rotated by one each round; a difference is taken inside a round. ways: { name: (round) => opsDone }.
// Returns per-way ns per op for every round; diff(a, b) gives the median and the lowest and highest round of a - b.
export function interleave(ways, { rounds = 9, warm = 1, ops }) {
  const names = Object.keys(ways)
  const xs = Object.fromEntries(names.map((k) => [k, []]))
  for (let w = 0; w < warm; w++) for (const k of names) ways[k](-1 - w)
  for (let r = 0; r < rounds; r++) {
    for (let j = 0; j < names.length; j++) {
      const k = names[(j + r) % names.length]
      gc(); const t0 = now(); const n = ways[k](r) ?? ops; xs[k].push(Number(now() - t0) / n)
    }
  }
  const ns = Object.fromEntries(names.map((k) => [k, stat(xs[k])]))
  const diff = (a, b) => stat(xs[a].map((x, i) => x - xs[b][i]))
  return { ns, diff, xs }
}

// ── varints (E-19's encoder and reader) ──
export function vlen(v) { let n = 1; while (v >= 128) { v = Math.floor(v / 128); n++ } return n }
export function putV(buf, p, v) { while (v >= 128) { buf[p++] = (v & 127) | 128; v = Math.floor(v / 128) } buf[p++] = v; return p }

// ── a version as text (E-56 positions, textform.mjs): the 63-bit number (epoch << 40 | sequence) in Crockford's
// base32, after one character that says how many digits follow, so plain `<` keeps log order. E-56 built it with
// BigInt; here it is built from the two numbers. 40 is a multiple of 5, so the sequence is the last 8 digits.
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const DIG = ALPHA.split('')
const PAIR = Array.from({ length: 1024 }, (_, i) => ALPHA[i >> 5] + ALPHA[i & 31]) // two digits at a time
function digs(x) { // x > 0, no leading zeros; small integers by bit operations
  let s = ''
  if (x < 2147483648) { while (x >= 1024) { s = PAIR[x & 1023] + s; x >>>= 10 } return (x >= 32 ? PAIR[x] : DIG[x]) + s }
  while (x >= 1024) { const q = Math.floor(x / 1024); s = PAIR[x - q * 1024] + s; x = q }
  return (x >= 32 ? PAIR[x] : DIG[x]) + s
}
export function vtext(epoch, seq) {
  if (epoch === 0) { if (seq === 0) return '10'; const d = digs(seq); return DIG[d.length] + d }
  let s = '', x = seq // the sequence's 8 digits, zero-padded, under the epoch's
  for (let i = 0; i < 4; i++) { const q = Math.floor(x / 1024); s = PAIR[x - q * 1024] + s; x = q }
  const d = digs(epoch) + s
  return DIG[d.length] + d
}
// The same text once a slot's epoch is above 0 (after a slot move, a restore or an unclean recovery), with the epoch's
// digits and the length character made once per slot and epoch (`eprefix`), so a call only writes the sequence's 8
// digits, 10 bits at a time. Checked against vtext.
export const eprefix = (epoch) => { const d = digs(epoch); return DIG[d.length + 8] + d }
export function vtextP(pre, seq) {
  return pre + PAIR[Math.floor(seq / 1073741824) & 1023] + PAIR[(seq >>> 20) & 1023] + PAIR[(seq >>> 10) & 1023] + PAIR[seq & 1023]
}
// E-56's form, line for line (BigInt), for the check and as a contrast
const SEQ_BITS = 40n
function digitsBig(n) { if (n === 0n) return '0'; let s = ''; while (n > 0n) { s = ALPHA[Number(n & 31n)] + s; n >>= 5n } return s }
export const vtextBig = (epoch, seq) => { const d = digitsBig((BigInt(epoch) << SEQ_BITS) | BigInt(seq)); return ALPHA[d.length] + d }

// a one-partition cursor in E-19's layout (E-56 textform.mjs): a 16-byte resource id, the incarnation, an entry
// count, then slot, epoch and sequence as varints; base64url text
export const RID = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 255))
const C1 = Buffer.alloc(64)
RID.copy(C1, 0)
export function cursor1(slot, epoch, seq) {
  let p = 16
  p = putV(C1, p, 3); p = putV(C1, p, 1); p = putV(C1, p, slot); p = putV(C1, p, epoch); p = putV(C1, p, seq)
  return C1.toString('base64url', 0, p)
}
// the same text, built faster: the id's first 15 bytes are 20 base64url characters that never change, so only the
// tail (the id's last byte, the varints) is encoded per call, 12 bits at a time from a table of character pairs
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64P = Array.from({ length: 4096 }, (_, i) => B64[i >> 6] + B64[i & 63])
const C1HEAD = RID.toString('base64url', 0, 15)
const T1 = new Uint8Array(32)
export function cursor1fast(slot, epoch, seq) {
  let n = 0
  T1[n++] = RID[15]; T1[n++] = 3; T1[n++] = 1
  while (slot >= 128) { T1[n++] = (slot & 127) | 128; slot >>>= 7 } T1[n++] = slot
  while (epoch >= 128) { T1[n++] = (epoch & 127) | 128; epoch >>>= 7 } T1[n++] = epoch
  while (seq >= 128) { const q = Math.floor(seq / 128); T1[n++] = (seq - q * 128) | 128; seq = q } T1[n++] = seq
  let s = C1HEAD, i = 0
  for (; i + 3 <= n; i += 3) { const x = (T1[i] << 16) | (T1[i + 1] << 8) | T1[i + 2]; s += B64P[x >> 12] + B64P[x & 4095] }
  if (n - i === 1) s += B64P[T1[i] << 4]
  else if (n - i === 2) { const x = (T1[i] << 8) | T1[i + 1]; s += B64P[x >> 4] + B64[(x & 15) << 2] }
  return s
}
// a whole-resource cursor, delta-coded as E-19's `delta` form: the id, the incarnation, the slot count, the epochs as
// runs (one run here: no unclean recovery), then each slot's sequence as a zigzag delta from the previous slot's
const CW = Buffer.alloc(16 + 16 + 4096 * 10)
RID.copy(CW, 0)
export function cursorWhole(seqs) { // seqs: Float64Array(4096), epoch 0 everywhere
  let p = 16
  p = putV(CW, p, 3); p = putV(CW, p, seqs.length); p = putV(CW, p, 1); p = putV(CW, p, seqs.length); p = putV(CW, p, 0)
  let prev = 0
  for (let i = 0; i < seqs.length; i++) { const d = seqs[i] - prev; prev = seqs[i]; p = putV(CW, p, d >= 0 ? d * 2 : -d * 2 - 1) }
  return CW.toString('base64url', 0, p)
}
export function decodeWhole(text) {
  const b = Buffer.from(text, 'base64url'); let q = 16
  const rv = () => { let v = 0, m = 1, x; do { x = b[q++]; v += (x & 127) * m; m *= 128 } while (x & 128); return v }
  rv(); const n = rv(); rv(); rv(); rv()
  const out = new Float64Array(n); let prev = 0
  for (let i = 0; i < n; i++) { const z = rv(); const d = z % 2 === 0 ? z / 2 : -(z + 1) / 2; prev += d; out[i] = prev }
  return out
}

// FNV-1a over a string's char codes: a key's slot, as a stand-in for the record header's slot (4,096 slots)
export function slotOf(k, slots = 4096) { let h = 0x811c9dc5; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 0x01000193) } return (h >>> 0) % slots }
