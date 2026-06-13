// cluster.writes perf invariants (resource/writes.ts). Unlike observe (which hooks the
// per-RECORD apply path), cluster.writes touches ONLY the opt-in confirm path — a bare
// fire-and-forget assignment never enters its code. The two guards reflect that:
//
//   I. STEADY-STATE UNTOUCHED (the hard requirement): fire-and-forget writes run at the
//      same speed whether or not cluster.writes is armed — its emit-sites live exclusively
//      inside writeWithConfirm's `confirm` branches, so the hot path has no new work at all.
//      SAME-PROCESS A/B (a ratio in one process catches a few-branch regression an absolute
//      ceiling with run-to-run variance can't). If someone later moves a hook onto the apply
//      path, this goes red.
//   II. BOUNDED RECORDING COST: while armed, each CONFIRM write also does two small proxy
//      mutations (insert pending → update settled). That is real work but paid only for
//      confirm:'committed'/'replicated' writes — which already pay a sequence + (for
//      replicated) an RTT — and the ring is bounded. Test II guards it stays a small
//      fraction of the confirm itself, not a balloon.

import { test } from 'node:test'
import { ok } from 'node:assert'
import { fero } from './index.ts'
import { ports, bench } from '#utils'

const N = 10_000

//! writeN: time N rewrites of one hot key — the steady-state FIRE-AND-FORGET path (no confirm, so cluster.writes never runs).
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

test('I. steady-state untouched: fire-and-forget writes ignore cluster.writes whether it is armed or not (the hard requirement)', async () => {
  const plain: any = await fero('cw-perf-plain', { port: await ports.free(), wait: 10 })
  const armed: any = await fero('cw-perf-armed', { port: await ports.free(), wait: 10 })
  void armed.cluster.writes // build + arm the ring — must NOT touch the fire-and-forget path
  writeN(plain)
  writeN(armed)
  const ratio = interleavedRatio(plain, armed)
  console.log(`  armed/plain fire-and-forget ratio: ${ratio.toFixed(3)} (want ≈ 1.0 — cluster.writes is confirm-only, the hot path has no new code)`)
  ok(ratio < 1.15, `arming cluster.writes must not change the fire-and-forget write speed (got ${ratio.toFixed(3)}×)`)
  plain.destroy()
  armed.destroy()
})

test('II. bounded recording cost: an armed cluster.writes does not balloon a confirm:committed write (regression guard)', async () => {
  const M = 2000
  const node: any = await fero('cw-perf-rec', { port: await ports.free(), wait: 10 })
  try {
    const confirmN = () =>
      bench.timeAsync(async () => {
        for (let j = 0; j < M; j++) await node.methods.update({ key: ['hot'], value: { v: j }, confirm: 'committed' })
      })
    // UNARMED: the writesLog gate is null → onStart/onSettle are predicted-false `?.` branches.
    const unarmed = await confirmN()
    void node.cluster.writes // ARM: now every confirm write also writes the ring (insert pending → update settled)
    const armed = await confirmN()
    const ratio = armed / unarmed
    console.log(`  armed/unarmed confirm:committed ratio: ${ratio.toFixed(3)} (worst case — a SINGLE-NODE committed write is network-free, so 2 reactive-proxy writes show up; negligible on the RTT-bearing committed-forwarded/replicated tiers)`)
    // This is the WORST case: the cheapest tier (local, no RTT) so the recording's two proxy
    // mutations are proportionally largest (~2–3× here, the tiny denominator is noisy). It is
    // NOT a claim recording is free — it's a regression guard against a BLOWUP (an accidental
    // deep clone of the value, a sync flush, a per-write O(n) scan), which would show 5–20×.
    // Ceiling = observed worst (~3×) + the 1.5× headroom observe.perf.ts uses for its noisy
    // active-overhead band; a true balloon still trips it, run-to-run jitter does not.
    ok(ratio < 4.5, `recording must not balloon a confirm write (got ${ratio.toFixed(3)}×, ceiling 4.5× on the network-free worst case)`)
  } finally {
    node.destroy()
  }
})
