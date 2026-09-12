//! ── 01 · one file, run it twice ──
//
//   terminal 1:  node server.ts
//   terminal 2:  node server.ts
//   prove it:    node check.ts
//
// The whole config is `server: true`. Each copy binds a free port, registers under the name 'hello'
// with the box's directory, finds the other copy by that name, and forms a view with it — zero
// addresses, zero identities. Each copy writes ONE row, keyed by its own uuid: plain assignment IS
// the replication api, and every copy prints the whole object on every replicated change.
//
// Ctrl-C one copy: destroy() LEAVES — the view shrinks by a ballot to `members 1` and the other copy
// carries on alone, still writable. Run the file again: the newcomer is voted in (`members 2`) and
// catches up. What two copies cannot survive is a CRASH (kill -9, a pulled plug): a dead member's vote
// is gone, and changing a view needs a majority of the OLD view, so the survivor waits at
// `writable false`. That is the deployment rule (13): three members, plus `dir`.

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
