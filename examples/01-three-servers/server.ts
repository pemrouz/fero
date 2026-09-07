//! ── 01 · one file, run it three times ──
//
//   terminal 1:  node server.ts
//   terminal 2:  node server.ts
//   terminal 3:  node server.ts
//   prove it:    node check.ts
//
// The whole config is `server: true`. Each copy binds a free port, registers under the name 'hello'
// with the box's directory, finds the other copies by that name, and forms a view with them — zero
// addresses, zero identities. Each copy writes ONE row, keyed by its own uuid: plain assignment IS
// the replication api, and every copy prints the whole object on every replicated change.
//
// Why three: writes commit on a MAJORITY of the view. Kill any one of three and the other two keep
// going; start the file again and the newcomer joins and catches up. Two copies replicate fine, and
// a clean stop (Ctrl-C) of one of two is fine too — destroy() LEAVES: the view shrinks by a ballot
// and the other carries on alone. What two cannot survive is a CRASH (kill -9, a pulled plug): a dead
// member's vote is gone, and changing a view needs a majority of the OLD view, so the survivor waits
// at `writable false` and nobody can be admitted. That is the deployment rule (13): three, plus `dir`.

import { fero } from '../../api/index.ts'
import { coalesce, logChanges, onExit, ticks } from '../lib.ts'

const f = await fero('hello', { server: true })                       //! server: true is the whole config — a free port, registered as 'hello'
const me = f.cluster.me.snapshot().uuid

const data = logChanges(), view = logChanges()                        //! print only when the picture changed (a tap fires per applied record)
f.data.tap(() => data(JSON.stringify(f.snapshot)))                    //! the render loop: once now, then on every replicated change (f.snapshot, never f.data)
f.cluster.tap(coalesce(() => {                                        //! the cluster is a view too: members, the write gate, where I listen
  const c = f.cluster.snapshot()                                      //! coalesce: its fields land one record at a time — read them once they have all landed
  view(`members ${Object.keys(c.members).length} writable ${c.writable} — I am ${me} on ${c.me.listen}`)
}))

let n = 0
const timer = setInterval(() => {
  f.data[me] = { ticks: ++n }                                          //! MY row, keyed by my uuid — one writer per key, the whole row each time
  if (n >= ticks()) { clearInterval(timer); void f.destroy() }         //! FERO_EXAMPLE_TICKS bounds a run (a check may set it); unset = forever
}, 1000)

onExit(async () => { clearInterval(timer); await f.destroy() })       //! Ctrl-C = a clean stop: destroy() LEAVES the view by ballot, then exits; without it the process never ends
