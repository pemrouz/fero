//! ── tools/perf/compare — the pure baseline-comparison policy (one module, two consumers) ────────
// The CLI (absolute.ts) and the gate (tests/baseline.perf.ts) both consume THIS, so the policy
// cannot fork. The verdict vocabulary is closed:
//   count-drift     — a wire-structural law moved: HARD FAIL on any machine (drift is always signal;
//                     a deliberate wire change re-pins WITH a DECISIONS entry).
//   ms-delta        — a median regressed past tolerance; ENFORCED only when the baseline is pinned
//                     AND the runner fingerprint matches (cross-machine ms comparison is meaningless).
//   improved        — faster past tolerance: a re-pin CANDIDATE, never a failure (plan §7.3:
//                     recalibration is data-driven).
//   probe-error     — a probe reported invalid: no number exists to compare (never fake-red/-green).
//   stale/unpinned  — row set drift between baseline and current probes, surfaced loudly.
//   no-runner-match — the honest third state: this box did not pin the baseline; ms is skipped
//                     with a message, never passed, never failed.
//   schema-unknown  — a future schema: both tiers skip LOUDLY (guessing would be dishonest).

import os from 'node:os'

export interface Fingerprint { host: string; os: string; cpu: string; nodeMajor: string }
export const fingerprint = (): Fingerprint => ({
  host: os.hostname(),
  os: os.type(),
  cpu: `${os.cpus()[0]?.model ?? 'unknown'} ×${os.cpus().length}`,
  nodeMajor: process.versions.node.split('.')[0],
})

export interface BaselineRunner {
  id: string        // operator label (--runner= at pin time) — display only, never matched
  posture: 'advisory' | 'pinned'
  host: string      // MATCHED
  os: string        // MATCHED
  release: string   // evidence only (WSL kernel patches must not orphan the baseline)
  cpu: string       // MATCHED (model ×count)
  node: string      // full version recorded; MAJOR only matched
}
export interface Baseline {
  schema: number
  kind: string
  rev: string
  when: string
  dirty: boolean
  reason: string
  supersedes: { rev: string; when: string } | null
  runner: BaselineRunner
  msTolerancePct: number
  counts: Record<string, number>
  probes: Record<string, { file: string; ms: number; n?: number; persec?: number; ratio?: number }>
}
export interface Current {
  counts: Record<string, number>
  probes: Record<string, { ms?: number; n?: number; persec?: number; ratio?: number; error?: string }>
}

export type Verdict =
  | { kind: 'count-drift'; key: string; want: number; got: number }
  | { kind: 'ms-delta'; id: string; pct: number; baseMs: number; curMs: number; enforce: boolean }
  | { kind: 'improved'; id: string; pct: number; baseMs: number; curMs: number }
  | { kind: 'probe-error'; id: string; error: string }
  | { kind: 'stale'; id: string }
  | { kind: 'unpinned'; id: string }
  | { kind: 'no-runner-match'; pinnedOn: string }
  | { kind: 'schema-unknown'; schema: unknown }

export const matches = (b: Baseline, f: Fingerprint): boolean =>
  b.runner.host === f.host && b.runner.os === f.os && b.runner.cpu === f.cpu &&
  b.runner.node.split('.')[0] === f.nodeMajor

export const compare = (b: Baseline, cur: Current, f: Fingerprint): Verdict[] => {
  if (b.schema !== 1) return [{ kind: 'schema-unknown', schema: b.schema }]
  const out: Verdict[] = []
  //! counts: exact, ALWAYS, on any machine — wire laws don't care about hardware
  for (const [key, want] of Object.entries(b.counts)) {
    const got = cur.counts[key]
    if (got === undefined) out.push({ kind: 'stale', id: key })
    else if (got !== want) out.push({ kind: 'count-drift', key, want, got })
  }
  for (const key of Object.keys(cur.counts)) if (!(key in b.counts)) out.push({ kind: 'unpinned', id: key })
  //! probe errors surface regardless of runner (an invalid probe is a fact, not a measurement)
  for (const [id, p] of Object.entries(cur.probes)) if (p.error) out.push({ kind: 'probe-error', id, error: p.error })
  //! the ms tier exists only on the box that pinned it
  if (!matches(b, f)) {
    out.push({ kind: 'no-runner-match', pinnedOn: `${b.runner.id} (${b.runner.host} / ${b.runner.cpu} / node ${b.runner.node})` })
    return out
  }
  const enforce = b.runner.posture === 'pinned'
  for (const [id, base] of Object.entries(b.probes)) {
    const p = cur.probes[id]
    if (!p) { out.push({ kind: 'stale', id }); continue }
    if (p.error || base.ms === 0 || p.ms === undefined) continue // errors already surfaced; ratios/informational rows skip ms math
    const pct = ((p.ms - base.ms) / base.ms) * 100
    if (pct > b.msTolerancePct) out.push({ kind: 'ms-delta', id, pct: +pct.toFixed(1), baseMs: base.ms, curMs: p.ms, enforce })
    else if (pct < -b.msTolerancePct) out.push({ kind: 'improved', id, pct: +pct.toFixed(1), baseMs: base.ms, curMs: p.ms })
  }
  for (const id of Object.keys(cur.probes)) if (!(id in b.probes) && !cur.probes[id].error) out.push({ kind: 'unpinned', id })
  return out
}

//! pinRefusal — every reason a pin must NOT be written (pure, unit-tested). null = allowed.
export const pinRefusal = (opts: {
  runner?: string
  reason?: string
  pinned: boolean
  release: string          // os.release() of the pinning box
  tier3Error?: string      // the socket probe's error, if any
  msTolerancePct: number
}): string | null => {
  if (!opts.runner) return 'a pin REQUIRES --runner=<label> — baselines carry their operator identity'
  if (!opts.reason) return 'a pin REQUIRES --reason "..." — recalibration is data-driven, and the datum starts with why'
  if (opts.pinned && /microsoft|wsl|virtual|vbox|vmware|hyper-v/i.test(opts.release))
    return `--pinned refused on '${opts.release}' — a WSL/VM box cannot be the pinned quiet runner (plan §6); pin advisory instead`
  if (opts.tier3Error) return `pin refused: the socket probe was invalid this run (${opts.tier3Error}) — a baseline must not persist a number that does not exist`
  if (!(opts.msTolerancePct >= 10 && opts.msTolerancePct <= 50))
    return `msTolerancePct ${opts.msTolerancePct} outside [10, 50] — the cap is what keeps tolerance from becoming a never-widen bypass`
  return null
}
