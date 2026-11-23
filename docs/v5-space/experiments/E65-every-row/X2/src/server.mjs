// E-65 X2 timing: one server process holding the copies of some groups, serving scan pages over TCP.
//
//   node src/server.mjs --groups=0,4,8,12 --G=16 --rows=10000000 --seed=1
//
// Rows are E-05's small row (about 114 B as JSON), keyed 'u<i>', hashed into 4,096 slots; slot s belongs to
// group s % G. Each group keeps its rows by slot (a Map per slot): the "rows by slot" form GROUPS G7 asks of
// data 5; plain Maps stand in for it here. Nothing here uses data.
//
// Protocol: frames [u32 length][payload]. A request is JSON:
//   { t: 'open', scan, g, enc, field, gt, cut }  opens a scan session on group g (a server-side cursor)
//   { t: 'next', scan, g, limit }                the next page of that session; pipelined (credit)
//   { t: 'close', scan }                         ends every session of the scan (and its pins)
//   { t: 'writes', perSec }                      start (perSec > 0) or stop a writer on every group here
//   { t: 'stats' }                               CPU and memory of this process, and pin images
// A page answer is [u32 header length][header JSON][body]; the header says the group, how many rows were looked
// at and sent, and the session's resume point (slot index, last key). Bodies:
//   enc 'json'  JSON of [[key, row], ...]          enc 'proj'  JSON of [[key, row[field]], ...]
//   enc 'col'   the values of one numeric field as raw float64, no keys
// A filter (gt) is pushed here: only rows with row[field] > gt are sent, all rows are looked at.
// 'cut': the session pins its group when it opens; the writer then keeps each not-yet-scanned row's image as it
// was at the pin, the first time the row changes, and the session serves the image.
import net from 'node:net'
import { args } from './lib.mjs'

const o = args(process.argv.slice(2), { groups: '0', G: 16, rows: 1e6, seed: 1, S: 4096 })
const BUG = process.env.SCAN_BUG ?? '' // a planted bug for the probe of the timed check (never set in timed runs)
const mine = new Set(String(o.groups).split(',').map(Number))
const S = o.S, G = o.G

export function slotOf(k) {
  let h = 0x811c9dc5
  for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13
  return (h >>> 0) % S
}
const REG = ['eu-west', 'eu-north', 'us-east', 'us-west', 'ap-south', 'ap-east', 'sa-east', 'af-south', 'me-central', 'ca-central', 'eu-south', 'us-central', 'ap-north', 'oc-east', 'eu-east', 'mx-central']
let rs = o.seed >>> 0
const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296 }
const makeRow = (i) => ({ name: 'user ' + i, email: 'u' + i + '@example.com', region: REG[i % 16], room: 'r' + (i % 1000), n: Math.floor(rnd() * 1000), active: rnd() < 0.5, tags: ['a', 'b'] })

// ── build the groups ──
const t0 = performance.now()
const groups = new Map() // g -> { slots: [s...] sorted, bySlot: Map(s -> Map(k -> row)), keys: [] }
for (const g of mine) groups.set(g, { g, slots: [], bySlot: new Map(), keys: [] })
for (let s = 0; s < S; s++) { const grp = groups.get(s % G); if (grp) { grp.slots.push(s); grp.bySlot.set(s, new Map()) } }
for (let i = 0; i < o.rows; i++) {
  const k = 'u' + i
  const s = slotOf(k)
  const grp = groups.get(s % G)
  if (!grp) continue
  grp.bySlot.get(s).set(k, makeRow(i))
  grp.keys.push(k)
}
let held = 0
for (const grp of groups.values()) held += grp.keys.length
const buildMs = performance.now() - t0

// ── scan sessions ──
const sessions = new Map() // `${scan}:${g}` -> session
const pinSums = new Map() // `${scan}:${g}` -> [sum of n, rows] at the session's open (the check only)
function openSession(q) {
  const grp = groups.get(q.g)
  const ss = { grp, slotIdx: 0, keys: null, ki: 0, after: null, enc: q.enc, field: q.field ?? 'n', gt: q.gt, done: false, pin: null }
  if (q.cut) ss.pin = { saved: new Map(), at: performance.now() }
  if (q.check) { let sum = 0, n = 0; for (const m of grp.bySlot.values()) for (const r of m.values()) { sum += r.n; n++ } pinSums.set(q.scan + ':' + q.g, [sum, n]) } // the check's own count at the pin, not timed
  sessions.set(q.scan + ':' + q.g, ss)
}
// has the session already passed this key? (slot order, then key order: the same order pages are cut in)
function passed(ss, s, k) {
  const si = ss.grp.slots.indexOf(s) // only on the write path with a pin; slots are 256 a group
  if (si !== ss.slotIdx) return si < ss.slotIdx
  return ss.after !== null && k <= ss.after
}
function nextPage(ss, limit) {
  const rows = []
  let looked = 0
  const { grp, field, gt } = ss
  while (rows.length < limit && ss.slotIdx < grp.slots.length) {
    const m = grp.bySlot.get(grp.slots[ss.slotIdx])
    if (!ss.keys) { ss.keys = [...m.keys()].sort(); ss.ki = 0 }
    while (ss.ki < ss.keys.length && rows.length < limit) {
      const k = ss.keys[ss.ki++]
      let row = m.get(k)
      if (ss.pin) { const img = ss.pin.saved.get(k); if (img !== undefined) { row = img; ss.pin.saved.delete(k) } } // passed: the image is no longer needed
      ss.after = k
      looked++
      if (gt !== undefined && !(row[field] > gt)) continue
      rows.push(ss.enc === 'json' ? [k, row] : ss.enc === 'proj' ? [k, row[field]] : row[field])
    }
    if (ss.ki >= ss.keys.length) { ss.slotIdx++; ss.keys = null; ss.after = null }
  }
  if (ss.slotIdx >= grp.slots.length) ss.done = true
  let body
  if (ss.enc === 'col') { const f = new Float64Array(rows); body = Buffer.from(f.buffer, f.byteOffset, f.byteLength) }
  else body = Buffer.from(JSON.stringify(rows))
  return { body, looked, n: rows.length }
}

// ── a writer on every group (whole-row writes of existing rows, uniform keys) ──
let writer = null, wrote = 0, saved = 0, peakImages = 0
function startWriter(perSec) {
  if (writer) clearInterval(writer)
  if (!perSec) { writer = null; return }
  const per = perSec / 100 // every 10 ms
  let carry = 0
  writer = setInterval(() => {
    carry += per
    const n = Math.floor(carry); carry -= n
    for (const grp of groups.values()) {
      for (let j = 0; j < n; j++) {
        const k = grp.keys[Math.floor(rnd() * grp.keys.length)]
        const s = slotOf(k)
        const m = grp.bySlot.get(s)
        const prev = m.get(k)
        for (const ss of sessions.values()) {
          if (BUG === 'noimage') continue // planted (the probe only): the writer keeps no image
          if (ss.pin && ss.grp === grp && !ss.done && !ss.pin.saved.has(k) && !passed(ss, s, k)) { ss.pin.saved.set(k, prev); saved++ }
          else if (BUG === 'everysave' && ss.pin && ss.grp === grp && !ss.done && !passed(ss, s, k)) ss.pin.saved.set(k, prev) // planted: a later change overwrites the image
        }
        m.set(k, { ...prev, n: Math.floor(rnd() * 1000) })
        wrote++
      }
    }
    let images = 0
    for (const ss of sessions.values()) if (ss.pin) images += ss.pin.saved.size
    if (images > peakImages) peakImages = images
  }, 10)
}

function stats() {
  let images = 0
  for (const ss of sessions.values()) if (ss.pin) images += ss.pin.saved.size
  const mu = process.memoryUsage()
  const r = { cpu: process.cpuUsage(), rss: mu.rss, heap: mu.heapUsed, images, peakImages, saved, wrote, held, buildMs }
  return r
}

// ── the socket ──
const server = net.createServer((sock) => {
  sock.setNoDelay(true)
  let buf = Buffer.alloc(0)
  sock.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0)
      if (buf.length < 4 + len) break
      const q = JSON.parse(buf.subarray(4, 4 + len).toString())
      buf = buf.subarray(4 + len)
      handle(sock, q)
    }
  })
  sock.on('error', () => {})
})
function send(sock, hdr, body) {
  const h = Buffer.from(JSON.stringify(hdr))
  const b = body ?? Buffer.alloc(0)
  const pre = Buffer.allocUnsafe(8)
  pre.writeUInt32LE(4 + h.length + b.length, 0); pre.writeUInt32LE(h.length, 4)
  sock.write(pre); sock.write(h); if (b.length) sock.write(b)
}
function handle(sock, q) {
  if (q.t === 'open') { openSession(q); return }
  if (q.t === 'next') {
    const ss = sessions.get(q.scan + ':' + q.g)
    const { body, looked, n } = nextPage(ss, q.limit)
    send(sock, { t: 'page', g: q.g, looked, n, done: ss.done, at: [ss.slotIdx, ss.after] }, body)
    return
  }
  if (q.t === 'close') { for (const key of [...sessions.keys()]) if (key.startsWith(q.scan + ':')) sessions.delete(key); return }
  if (q.t === 'writes') { startWriter(q.perSec); send(sock, { t: 'ok' }); return }
  if (q.t === 'stats') { send(sock, { t: 'stats', ...stats() }); if (q.reset) { peakImages = 0; saved = 0; wrote = 0 } return }
  if (q.t === 'truth') { // the check's numbers, counted here over the rows held (not timed)
    let count = 0, sum = 0, over = 0; const hist = new Array(1000).fill(0)
    for (const grp of groups.values()) for (const m of grp.bySlot.values()) for (const r of m.values()) { count++; sum += r.n; if (r.n > 899) over++; hist[r.n]++ }
    send(sock, { t: 'truth', count, sum, over, hist }); return
  }
  if (q.t === 'pinsums') { const r = {}; for (const g of groups.keys()) r[g] = pinSums.get(q.scan + ':' + g); send(sock, { t: 'pinsums', r }); return }
  if (q.t === 'quit') { process.exit(0) }
}
server.listen(0, '127.0.0.1', () => {
  process.send?.({ port: server.address().port, held, buildMs })
})
