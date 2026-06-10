// The observe push-hook's two perf invariants (plan §6), guarded by SAME-PROCESS A/B
// (an absolute ceiling with run-to-run variance can't catch a few-branch regression — a
// ratio in one process can). bench.time = one untimed warmup + median-of-5.
//
//   I.  ZERO-COST-WHEN-UNWATCHED (the hard requirement): a node CONFIGURED with observe
//       but with NO subscriber attached must write at the same speed as a node with no
//       observe at all. The emit-sites are `observe?.onRecord(...)` — optional chaining
//       short-circuits before the args evaluate, so an unwatched gate is one predicted-false
//       branch. Test A asserts configured-unwatched ≈ plain.
//   II. BOUNDED ACTIVE OVERHEAD: while a subscriber IS attached, each write also builds a
//       flat ProvRecord and streams it (one data-proxy slot write + the sink delivery). That
//       is REAL work — measured ~3× the bare write on this local-write microbench — but it is
//       paid ONLY while watching (a debug session), and the ring buffer is bounded so memory
//       can't grow. Test B guards it doesn't regress FURTHER (a tighter active path — batched
//       off-tick flush — is a deferred optimization; see tools/observe/IDEAS.md).
//   III.LEAK-AS-PERF-FAILURE (closes the loop): attach + drop a subscriber UNGRACEFULLY, then
//       time writes — they must be back at the unwatched baseline. If the gate leaked armed,
//       the emits would still fire and this goes red, turning an invisible steady-state leak
//       into a hard failure.

import { test } from 'node:test'
import { ok } from 'node:assert'
import { value } from '../../data/index.ts'
import { fero, diagnostics } from './index.ts'
import { ports, bench } from '#utils'

const N = 10_000

//! time N rewrites of one hot key (the steady-state local-commit path — where the commitLocal emit-site lives).
const writeN = (s: any) =>
  bench.time(() => {
    for (let j = 0; j < N; j++) s.data.hot = { v: j }
  })

//! median of K interleaved A/B ratios — interleaving cancels the JIT/GC ordering drift a single back-to-back compare suffers.
const interleavedRatio = (a: any, b: any, rounds = 5): number => {
  const ratios: number[] = []
  for (let i = 0; i < rounds; i++) {
    const ta = writeN(a)
    const tb = writeN(b)
    ratios.push(tb / ta)
  }
  ratios.sort((x, y) => x - y)
  return ratios[ratios.length >> 1]
}

test('I. zero-cost-when-unwatched: observe configured-but-no-subscriber ≈ a plain node (the hard requirement)', async () => {
  const plain: any = await fero('perf-plain', { port: await ports.free(), wait: 10 })
  const unwatched: any = await fero('perf-unwatched', { port: await ports.free(), wait: 10, observe: true })
  // warm both, then interleave
  writeN(plain)
  writeN(unwatched)
  const ratio = interleavedRatio(plain, unwatched)
  console.log(`  unwatched/plain write ratio: ${ratio.toFixed(3)} (want ≈ 1.0 — the emit-sites are predicted-false branches when no one watches)`)
  ok(ratio < 1.15, `configured-but-unwatched should match plain within 15% (got ${ratio.toFixed(3)}×) — the unwatched gate must add no real work`)
  plain.destroy()
  unwatched.destroy()
})

test('II. bounded active overhead: an attached in-process subscriber stays within the measured band (no FURTHER regression)', async () => {
  const unwatched: any = await fero('perf-unw2', { port: await ports.free(), wait: 10, observe: true })
  const watched: any = await fero('perf-watched', { port: await ports.free(), wait: 10, observe: true })
  const close = watched[diagnostics].observe(() => {}) // a no-op sink: the gate is armed, every write emits + streams
  writeN(unwatched)
  writeN(watched)
  const ratio = interleavedRatio(unwatched, watched)
  console.log(`  watched/unwatched write ratio: ${ratio.toFixed(3)} (≈3× measured — the cost of streaming every record's provenance; paid ONLY while watching)`)
  // Generous ceiling (measured ~3.1×): this is the active-debug cost, not the steady state. It
  // guards a 2× FURTHER blowup (e.g. an accidental per-record marks()/clone) without pretending
  // the inherent streaming cost is "small". If this regresses, move the work off-tick — don't relax it.
  ok(ratio < 4.5, `active overhead should stay within the measured band (got ${ratio.toFixed(3)}×, ceiling 4.5×)`)
  close()
  unwatched.destroy()
  watched.destroy()
})

test('III. leak-as-perf-failure: after an UNGRACEFUL subscriber drop, writes return to the unwatched baseline', async () => {
  const plain: any = await fero('perf-leak-plain', { port: await ports.free(), wait: 10 })
  const server: any = await fero('perf-leak', { port: await ports.free(), wait: 10, observe: true })
  const port = +server.cluster.me.split(':')[1]
  const client: any = await fero('perf-leak', { ports: [port], wait: 10 })
  // arm via the WIRE, then drop the client ungracefully (server-side abrupt close — no UNSUBSCRIBE)
  client.methods.__observe().connect([], () => {})
  const t0 = Date.now()
  while (server[diagnostics].observing() === false && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10))
  ok(server[diagnostics].observing() === true, 'armed while the wire subscriber is attached')
  const peers = (server.cluster.peers as any)[value] ?? {}
  const clientAddr = Object.keys(peers).find((a) => peers[a]?.role === 'client') // the lone read-only client
  server[diagnostics].drop(clientAddr!)
  client.destroy()
  // wait for the gate to disarm (the leak fix)
  const t1 = Date.now()
  while (server[diagnostics].observing() !== false && Date.now() - t1 < 4000) await new Promise((r) => setTimeout(r, 10))
  ok(server[diagnostics].observing() === false, 'the gate disarmed after the ungraceful drop')
  // now writes on `server` must be back at the plain baseline — if the gate leaked, they'd be ~3× and this fails
  writeN(plain)
  writeN(server)
  const ratio = interleavedRatio(plain, server)
  console.log(`  post-drop server/plain write ratio: ${ratio.toFixed(3)} (want ≈ 1.0 — a leaked gate would show ~3×)`)
  ok(ratio < 1.2, `after an ungraceful drop the write path must be back at baseline (got ${ratio.toFixed(3)}×) — a leak would surface here`)
  plain.destroy()
  server.destroy()
})
