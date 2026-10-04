// sections/inside/worker.js — §04's "rebuild from the seed ▸": an OWN RUN, in a module Worker.
// The visitor's session is rebuilt from its seed and its logged actions, exactly as LiveCluster.replay
// does it (run to each action's simulated time, check the event index, apply it), with one difference:
// every node's journal keeps every line. The kernel's own emit calls are unchanged; only where the lines
// are kept changes (an array instead of the ring). The journal is never read back by the kernel (only
// kernel/diag.js reads it, for diagnostics), so the run is the same run — and the rolling trace hash
// over every event must equal the page's at the same simulated moment, which this worker checks and says.
// Then the debugger's model folds it (./fold.js), and the page asks for the fold at any moment.
import { LiveCluster } from '../../core.js'
import { Clock, fold, viewAt, marks, captureNode, noteCuts, CUT_EVENTS } from './fold.js'

let twin = null, clock = null, F = null, src = null

// keep every journal line of this node from now on (a fresh journal: nothing has wrapped yet)
function keepAll(node, uuid) {
  const j = node.journal
  if (j.__all) return
  if (j.dropped) throw new Error(`${uuid}'s journal had already wrapped`)
  const rows = j.read(0)
  j.emit = (kind, a, b, c) => { const t = j.n++; rows.push({ t, kind, a, b, c }); clock.row(node, uuid, twin.sim.now) }
  j.read = (from = 0) => (from <= 0 ? rows.slice() : rows.slice(from))
  j.__all = rows
}

function build({ opts, actions, want }) {
  twin = new LiveCluster({ ...opts, paced: false })
  clock = new Clock()
  for (const [u, n] of twin.sim.nodes) { clock.sync(n, u, twin.sim.now); keepAll(n, u) }
  twin.on('restart', (id) => { const n = twin.node(id); clock.sync(n, id, twin.sim.now); keepAll(n, id) })
  twin.on('join', (id) => { const n = twin.node(id); clock.sync(n, id, twin.sim.now); keepAll(n, id) })
  twin.on('kill', (id) => { const n = twin.node(id); clock.died(n, twin.sim.now, captureNode(n), 'down') })
  twin.on('left', (id) => clock.died(twin.node(id), twin.sim.now, null, 'left'))
  const cuts = new Map() // when each node was cut off from every other node, as the page notes it (./fold.js)
  for (const ev of CUT_EVENTS) twin.on(ev, () => noteCuts(twin, cuts))
  const STEP = 15000
  let lastPost = 0
  const runTo = (T) => {
    while (twin.now + STEP < T) {
      twin.runTo(twin.now + STEP)
      const now = performance.now(); if (now - lastPost > 120) { lastPost = now; postMessage({ type: 'progress', at: twin.now }) }
    }
    twin.runTo(T)
  }
  let diverged = null
  for (const a of actions) {
    runTo(a.at)
    if (twin.events !== a.ev && !diverged) diverged = { op: a.op, at: a.at, ev: a.ev, events: twin.events }
    twin[a.op](...a.args)
  }
  runTo(want.now)
  const same = !diverged && twin.traceCount === want.traceCount && twin.traceHash === want.traceHash && twin.events === want.events
  F = fold(twin.sim, clock)
  src = {
    at: F.at, tmin: F.tmin, rows: F.rows, dropped: F.dropped, ms: F.ms, nodes: F.cap.nodes.length, marks: marks(F),
    replay: F.replay.map((r) => ({ ...r, dropped: F.cap.nodes.find((n) => n.uuid === r.uuid)?.dropped ?? 0 })),
    down: [...twin.down], left: [...twin.left], servers: [...twin.serverIds], cuts, seed: twin.seed, own: true,
  }
  postMessage({ type: 'ready', same, diverged, events: twin.events, traceCount: twin.traceCount })
}

onmessage = (m) => {
  const d = m.data
  try {
    if (d.type === 'build') build(d)
    else if (d.type === 'view' && F) postMessage({ type: 'view', V: viewAt(F, clock, d.T, { rows: d.rows }), src })
  } catch (e) { postMessage({ type: 'error', message: String(e && e.message || e) }) }
}
