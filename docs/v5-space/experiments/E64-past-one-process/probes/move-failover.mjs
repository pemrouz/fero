// E-64 probe (added after the skeptic's review): O1's merger when a partial's host fails while a paired slot move
// is still queued for the merger. O1's seeded run (O1/sim/sim.mjs) never makes this case: there a move happens at
// both groups in one step, and a resync's picture is taken BEFORE any queued move, with the old host's queue kept.
// A real new host is a copy at its own head, which may be past the move, and the old host's queue is gone.
// Uses O1's own Partial and Merger, unchanged. 20 rows: 10 in group A, 10 in group B; 5 of A's move to B.
//   node probes/move-failover.mjs     one JSON line per case; "rows" must equal "truth" (20)
import { Partial } from '../O1/src/partial.mjs'
import { Merger } from '../O1/src/merger.mjs'

function world() {
  const A = new Partial('A'), B = new Partial('B'), M = new Merger()
  const row = (i) => ({ id: 'k' + i, points: i, room: 'r' })
  A.apply([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({ k: 'k' + i, prev: undefined, next: row(i) })))
  B.apply([11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((i) => ({ k: 'k' + i, prev: undefined, next: row(i) })))
  M.install('A', A.picture()); M.install('B', B.picture())
  const before = { A: A.picture(), B: B.picture() } // what a picture at the merger's position (before the move) holds
  const keys = ['k1', 'k2', 'k3', 'k4', 'k5']
  const pairs = keys.map((k) => [k, A.rows.get(k)])
  const fence = A.dropRows(keys), open = B.takeRows(pairs) // the move at the groups: both halves now queued, paired
  return { A, B, M, before, fence, open }
}
const rows = (M) => M.addOut('*')[0]
const out = []
for (const failing of ['A', 'B']) {
  // 1. O1's sim: the new host's picture is at the merger's position, before the move; the old queue is kept,
  //    so the pair is still taken whole (rule 3). Right, but a real new host cannot do this.
  { const w = world(); w.M.install(failing, w.before[failing]); w.M.apply('A', w.fence); w.M.apply('B', w.open)
    out.push({ failing, case: 'sim: picture before the move, old queue kept', truth: 20, rows: rows(w.M) }) }
  // 2. A real new host: its picture is at its own head, past its half of the move; the old queue (with that half)
  //    is gone. Rule 4 installs it; rule 3's pair can never head both queues again.
  { const w = world(); w.M.install(failing, w[failing].picture())
    out.push({ failing, case: 'new host at its head, picture installed alone (rules 1, 3, 4)', truth: 20, rows: rows(w.M) }) }
  // 3. A fourth rule: a picture that passed a queued move carries it, and the merger installs the picture together
  //    with the move's other half, at one cut (nothing shown in between).
  { const w = world(); w.M.install(failing, w[failing].picture())
    if (failing === 'A') w.M.apply('B', w.open); else w.M.apply('A', w.fence)
    out.push({ failing, case: 'fourth rule: picture installed with the other half', truth: 20, rows: rows(w.M) }) }
}
for (const o of out) console.log(JSON.stringify(o))
