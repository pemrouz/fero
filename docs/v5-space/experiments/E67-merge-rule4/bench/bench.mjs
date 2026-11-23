// E-67, the timings that decide between the forms. One part per process (run.sh runs each three times, each
// run alone under the timing lock). Inside a run: the median of ROUNDS rounds after one warm-up round, a full
// collection before each round. Rows are { id, points, room } as in the seeded run (points 0 to 100 with two
// decimals, 50 rooms), so the partial keeps all six views of E-64 O1 (src/partial.mjs, unchanged).
//   --part=picture  (a) a takeover: the new host builds its partial over the group's n rows (takeRows), then
//                   takes its picture; and the picture's size as JSON. While this runs the group's part at the
//                   merger is frozen.
//   --part=install  (a) the merger installs one group's picture of n rows while it holds G groups of n rows
//                   each, in O1's one-entry form (install scans every group's window and filter entries) and in
//                   the per-group form E-67 uses. While it runs the merger takes nothing from any group.
//   --part=ring     (b) the partial on every copy: per record, the frame (six views, or sums only), the frame
//                   encoded as JSON (what a ring that keeps bytes would store: N7), and the ring's push; then a
//                   resend: the merger taking R = 16, 64, 256 frames from a ring.
//   --part=movepart (c) a move part: the moving slots' rows (1, 8, 64 slots of 4,096) at n rows a resource
//                   become a part at the merger (a partial over them, its picture, the install), and later
//                   leave (dropGroup); and the rows' size as JSON (what every copy of the source keeps until
//                   the merger closes the move).
import { rng, OrderIndex2 } from '../src/lib.mjs'
import { Partial } from '../src/partial.mjs'
import { Merger } from '../src/merger.mjs'

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const PART = arg('part', 'picture')
const gc = globalThis.gc ?? (() => {})
const now = () => process.hrtime.bigint()
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1] }
const out = (o) => console.log(JSON.stringify({ part: PART, ...o }))
const timeIt = (fn, rounds = 5, setup = () => {}) => { setup(); fn(); const ts = []; for (let i = 0; i < rounds; i++) { setup(); gc(); const t0 = now(); fn(); ts.push(Number(now() - t0)) } return med(ts) }
const R = rng(42)
const mkRow = (i) => ({ id: 'k' + i, points: Math.floor(R() * 10001) / 100, room: 'r' + Math.floor(R() * 50) })
const rowsOf = (n, base = 0) => { const a = []; for (let i = 0; i < n; i++) a.push(['k' + (base + i), mkRow(base + i)]); return a }

if (PART === 'picture') {
  for (const n of [1e4, 1e5, 1e6]) {
    const rows = rowsOf(n)
    let p
    const rounds = n >= 1e6 ? 3 : 5
    const build = timeIt(() => { p = new Partial(0); p.takeRows(rows) }, rounds)
    let pic
    const take = timeIt(() => { pic = p.picture() }, rounds)
    const bytes = JSON.stringify({ win: pic.win, add: [...pic.add].map(([b, e]) => [b, e.n, e.ws.value()]), ext: [...pic.ext], uni: [...pic.uni], dis: [...pic.dis], bool: pic.bool }).length
    out({ n, buildMs: build / 1e6, pictureMs: take / 1e6, totalMs: (build + take) / 1e6, bytes })
  }
}

if (PART === 'install') {
  const sizes = arg('n', '10000,100000').split(',').map(Number), Gs = arg('g', '1,4,16').split(',').map(Number)
  for (const n of sizes) for (const G of Gs) {
    if (n * G > 4e6) continue
    const pics = []
    for (let g = 0; g < G; g++) { const p = new Partial(g); p.takeRows(rowsOf(n, g * n)); pics.push(p.picture()) }
    // the takeover's picture for group 0: its rows changed a little (1 %), as after a short gap
    const p0 = new Partial(0); const r0 = rowsOf(n, 0); for (let i = 0; i < n / 100; i++) r0[i][1] = { ...r0[i][1], points: r0[i][1].points + 1 }
    p0.takeRows(r0); const pic0 = p0.picture()
    for (const keys of ['one', 'group']) {
      let M
      const t = timeIt(() => M.install(0, pic0), n * G >= 1e6 ? 3 : 5, () => { M = new Merger({ keys }); for (let g = 0; g < G; g++) M.install(g, pics[g]) })
      out({ n, G, keys, installMs: t / 1e6 })
    }
  }
}

if (PART === 'ring') {
  // three partials: 'sums' (the add class: two deltas a change, no state), 'top10' (the window class as O1's
  // partial does it: the group's index, then one reconcile of its top 10 with two Maps a commit), 'six' (O1's
  // whole partial; its max and distinct rescan the touched bucket's rows, about n / 50 here)
  for (const n of [1e5, 1e6]) {
    const rows = rowsOf(n)
    const W0 = n >= 1e6 ? 100000 : 200000
    const wr = []
    for (let w = 0; w < W0; w++) { const i = Math.floor(R() * n); wr.push([i, Math.floor(R() * 10001) / 100, R() < 0.1 ? 'r' + Math.floor(R() * 50) : undefined]) }
    const cur = rows.map(([, r]) => r)
    const changes = wr.map(([i, pts, room]) => { const prev = cur[i]; const next = { ...prev, points: pts }; if (room) next.room = room; cur[i] = next; return { k: 'k' + i, prev, next } })
    for (const form of ['sums', 'top10', 'six']) {
      if (form === 'six' && n >= 1e6) continue
      const cs = form === 'six' ? changes.slice(0, 20000) : changes
      const ringN = 64
      let frames
      const run = (encode) => {
        let step
        if (form === 'six') { const p = new Partial(0); p.takeRows(rows); step = (c) => p.apply([c]) }
        else if (form === 'top10') {
          const ix = new OrderIndex2('za'), rm = new Map(rows)
          ix.build(rows.map(([k, r]) => ({ v: r.points, k })))
          let win = ix.first(10).map((e) => [e.k, rm.get(e.k)])
          step = (c) => {
            ix.remove(c.prev.points, c.k); ix.insert(c.next.points, c.k); rm.set(c.k, c.next)
            const nowW = ix.first(10).map((e) => [e.k, rm.get(e.k)])
            const nowKeys = new Map(nowW), was = new Map(win), put = [], drop = []
            for (const [k] of win) if (!nowKeys.has(k)) drop.push(k)
            for (const [k, row] of nowW) if (was.get(k) !== row) put.push([k, row])
            win = nowW
            return { win: { put, drop } }
          }
        } else step = (c) => ({ add: [[c.prev.room, c.prev.points, -1], ['*', c.prev.points, -1], [c.next.room, c.next.points, 1], ['*', c.next.points, 1]] })
        const ring = new Array(ringN); let at = 0, bytes = 0
        frames = []
        const t0 = now()
        for (const c of cs) {
          const f = step(c)
          if (encode) { const s = JSON.stringify(f); bytes += s.length; ring[at++ % ringN] = s } else ring[at++ % ringN] = f
          if (frames.length < 256) frames.push(f)
        }
        return { ns: Number(now() - t0) / cs.length, bytes: bytes / cs.length }
      }
      const a = [], b = []
      let perBytes = 0
      run(false)
      for (let i = 0; i < 3; i++) { gc(); a.push(run(false).ns); gc(); const r = run(true); b.push(r.ns); perBytes = r.bytes }
      // a resend: the merger takes R frames from the ring, decoded from JSON as they would cross a link
      const res = {}
      const M = new Merger()
      const p = new Partial(0); p.takeRows(rows); M.install(0, p.picture())
      for (const RN of [16, 64, 256]) {
        const enc = frames.slice(0, RN).map((f) => JSON.stringify(f))
        res['resend' + RN + 'Us'] = timeIt(() => {
          for (const s of enc) {
            const f = JSON.parse(s)
            if (f.add) for (const [bk, v, sg] of f.add) M.addDelta(0, bk, v, sg)
            if (f.win) { for (const k of f.win.drop) M.winDrop(0, k); for (const [k, row] of f.win.put) M.winPut(0, k, row) }
          }
        }) / 1e3
      }
      out({ n, form, records: cs.length, perRecordUs: med(a) / 1e3, perRecordEncodedUs: med(b) / 1e3, bytesPerFrame: perBytes, ...res })
    }
  }
}

if (PART === 'movepart') {
  for (const n of [1e5, 1e6]) {
    const perSlot = n / 4096
    for (const slots of [1, 8, 64]) {
      const m = Math.round(perSlot * slots)
      const rows = rowsOf(m)
      const M = new Merger()
      const base = new Partial(0); base.takeRows(rowsOf(Math.min(n, 1e5), 1e7)); M.install(0, base.picture())
      const make = timeIt(() => { const p = new Partial('m'); p.takeRows(rows); M.install('m', p.picture()); M.dropGroup('m') })
      const bytes = JSON.stringify(rows).length
      out({ n, slots, rows: m, partMs: make / 1e6, rowsBytes: bytes })
    }
  }
}
