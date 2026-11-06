// run3 — E-22 step 3: run one check module in one mode, inject a leader change and a slot move
// inside the work, record every client history, check it directly, and export it for the outside
// checkers (Porcupine; Elle runs on its own workload, elle-saga.check.ts).
//
//   node --experimental-strip-types --no-warnings verify/run3.ts <check file> --mode calm|faults|shuffle
//        [--seeds N | --seed S [--trace]] [--hist out.jsonl] [--json summary.json] [--mutant name]
//   E22_DUMP=<resource> prints that resource's logs at the end of each seed (for tracing a failure)
//
// Modes (TEST-12, Q-22):
//   calm     the shuffle off; the check's random fault schedule (its chaos call: leader changes and
//            slot moves at seeded times) dropped. Its scripted scenario stays: kills, pauses, clock
//            skews, a window of message loss, and a failover the pattern itself is about (P-02's
//            expiry across a failover, P-10's and P-15's #locks failover, P-13's #sessions failover,
//            the check-then-set race across a failover)
//   faults   the shuffle off; the check's own faults, plus one forced leader change of the group and
//            one forced move of the slot that a write in flight is using (seeded, 0.05-0.6 ms after
//            the write starts, at the 1st-3rd write after the check starts its work)
//   shuffle  as faults, with TEST-12's shuffle on: different partitions arrive in a seeded order
//
// Direct checks on every seed (exact, from the history and the committed log):
//   once       no attempt id commits twice in one resource (exactly once)
//   refusal    an attempt refused once (and never re-sent) never commits later (P-14)
//   acked      every acknowledged write is in the committed log with the version its ack gave
//   kept       no committed entry is later lost (Raft safety in the prototype)
//   fence-log  in each group's log, no write under a token older than one already in that log (TEST-13)
//   fence-rt   no fenced write is acknowledged if it started after a write under a newer token of the
//              same lock was acknowledged (a stronger, real-time form: reported, not required)
//   session    a process's plain reads of a row never go back in version, and see its own writes
// Mutants (to show the checkers catch real bugs in real histories): `nodedup` (writers forget attempts,
// so a resend applies twice), `lostcommit` (an election may pick a voter that lacks committed entries).

import { writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const file = resolve(args[0])
const flag = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const mode = (flag('--mode') ?? 'shuffle') as 'calm' | 'faults' | 'shuffle'
const histOut = flag('--hist')
const jsonOut = flag('--json')
const mutant = flag('--mutant')
const base = file.split('/').pop()!
// the harness reads --seeds, --seed and --trace from process.argv when it loads
const pass: string[] = []
for (const k of ['--seeds', '--seed']) { const v = flag(k); if (v !== undefined) pass.push(k, v) }
if (args.includes('--trace')) pass.push('--trace')
if (!pass.includes('--seeds') && !pass.includes('--seed')) pass.push('--seeds', '100')
process.argv = [process.argv[0], process.argv[1], ...pass]

process.env.E22_MODE = mode
const { fero } = await import('../proto/index.ts')
const { Rng, ms: msOf } = await import('../proto/util.ts')

const INF = 1e12
const WRITES = new Set(['set', 'remove', 'batch', 'touch', 'claim'])
// checks with no chaos call (or one only in some seeds) arm the forced faults once setup has settled
const ARM_ON_SETTLE = new Set(['cts.check.ts', 'core-features.check.ts'])

interface Cap { g: string; res: string; i: number; e: any; tA: number; tC: number }
interface SeedState {
  w: any; seed: number; installed: boolean
  elections: { t: number; res: string; gid: string; lost: number }[]
  appendT: Map<string, number>
  commits: Cap[]
  armed: boolean; forced: any[] | null; pending: ('leader-change' | 'move')[]
  rng: any
  tick?: () => void
  hits: number
}
interface SeedOut {
  seed: number
  cover: { lcInFlight: boolean; moveInFlight: boolean; elections: number; lost: number; moves: number; movesDone: number; forced: string; dedup: number; mutantHits: number }
  direct: Record<string, number>
  directEx: string[]
  kv: { parts: number; ops: number; skipped: Record<string, number> }
}
const outs: SeedOut[] = []
const states: SeedState[] = []

// ── the world hook: every world the check makes gets the mode and the recorders ───────────────
const origWorld = (fero as any).world
;(fero as any).world = (o: any = {}) => {
  const w = origWorld({ ...o, shuffle: mode === 'shuffle' ? (o.shuffle ?? true) : false })
  const S: SeedState = { w, seed: w.seed, installed: false, elections: [], appendT: new Map(), commits: [], armed: false, forced: null, pending: [], rng: new Rng(w.seed * 7919 + 13), hits: 0 }
  states.push(S)
  const ch = w.chaos.bind(w)
  // calm: the check's random fault schedule (its chaos: leader changes and moves) is dropped; its
  // scripted scenario (kills, pauses, skews, message loss, a failover the pattern is about) stays
  w.chaos = (spec: any = {}) => {
    if (mode === 'calm') return []
    const r = ch(spec)
    if (!ARM_ON_SETTLE.has(base)) force(S, msOf(spec.within ?? '200ms', 0))
    return r
  }
  const st = w.settle.bind(w)
  w.settle = (m?: any) => st(m).then(() => { if (ARM_ON_SETTLE.has(base) && !S.armed) { S.armed = true; force(S, 20) } })
  const rec = w.record.bind(w)
  w.record = (op: any) => { install(S); S.tick?.(); const r = rec(op); onRecord(S, op); return r }
  const cl = w.close.bind(w)
  w.close = async () => { if (!w._analysed) { w._analysed = true; analyse(S) } return cl() }
  return w
}

const install = (S: SeedState): void => {
  if (S.installed || !S.w.kernel) return
  S.installed = true
  const w = S.w, k = w.kernel
  const ea = k.electAnew.bind(k)
  k.electAnew = (g: any, o: any) => {
    const before = k.stats.lost
    if (mutant === 'lostcommit') {
      // the mutant: the new leader lacks the newest committed write and what follows it (a vote
      // rule that ignores what a majority stored), so an acknowledged write is lost
      const r = ea(g, o)
      let drop = Math.min(g.commit, g.last)
      while (drop > g.base && g.entry(drop)?.k !== 'w') drop--
      if (drop > g.base) {
        g.log.length = drop - 1 - g.base
        g.commit = Math.min(g.commit, drop - 1)
        for (const [v2, m] of g.match) if (m > g.last) g.match.set(v2, g.last)
        for (const [v2, m] of g.persisted) if (m > g.last) g.persisted.set(v2, g.last)
        S.hits++
      }
      S.elections.push({ t: w.time, res: g.res, gid: g.id, lost: k.stats.lost - before })
      return r
    }
    const r = ea(g, o)
    S.elections.push({ t: w.time, res: g.res, gid: g.id, lost: k.stats.lost - before })
    return r
  }
  const ap = k.append.bind(k)
  k.append = (g: any, by: string, term: number, es: any[]) => {
    const r = ap(g, by, term, es)
    if (Array.isArray(r)) for (const e of r) S.appendT.set(`${g.id}:${e.i}`, w.time)
    return r
  }
  k.hooks.commit.push((g: any, prev: number, to: number) => {
    for (let i = prev + 1; i <= to; i++) {
      const e = g.entry(i)
      if (e) S.commits.push({ g: g.id, res: g.res, i, e, tA: S.appendT.get(`${g.id}:${i}`) ?? w.time, tC: w.time })
    }
  })
  if (mutant === 'nodedup') {
    // the mutant: each writer forgets its attempt table before it judges, so a resend applies again
    const l2 = internalsStack(w).l2
    const seen = new WeakSet<any>()
    S.tick = () => {
      for (const wr of l2.writers.values()) {
        if (seen.has(wr)) continue
        seen.add(wr)
        const h = wr.handle.bind(wr)
        wr.handle = (req: any, reply: any) => { if (wr.attempts.has(req.a)) S.hits++; wr.attempts.clear(); return h(req, reply) }
      }
    }
  }
}
let internalsStack: (w: any) => any = () => { throw new Error('not loaded') }
{
  const { internals } = await import('../proto/index.ts')
  internalsStack = (w) => internals.stack(w)
}

/** the row key a history op writes (the first one of a batch) */
const rowKeyOf = (op: any): string | undefined => {
  if (op.op === 'claim' || op.op === 'touch') return op.key === undefined ? undefined : String(op.key)
  const k = op.key
  if (k === undefined) return undefined
  if (Array.isArray(k)) return Array.isArray(k[0]) ? String(k[0][0]) : String(k[0])
  return String(k)
}

/** the forced faults: one leader change and one slot move at seeded times inside the window the
 *  check gave its own chaos (its `within`: the work's virtual length), each aimed at the group and
 *  slot of a write in flight at that moment; if none is in flight, at the next write that starts,
 *  0.05-0.6 ms after it starts */
const aim = (S: SeedState, what: 'leader-change' | 'move', op: any): void => {
  const w = S.w, k = w.kernel
  const meta = k.meta(op.res)
  if (!meta) { S.forced!.push({ do: what, missed: true }); return }
  const p = k.partitionOf(meta, rowKeyOf(op)!), slot = k.slotOf(p), g = k.groupOf(meta, slot)
  if (what === 'move' && meta.groups.length < 2) { S.forced!.push({ do: what, missed: true }); return }
  const step = what === 'leader-change' ? { at: w.time, do: what, res: op.res, group: g.n } : { at: w.time, do: what, res: op.res, slot }
  S.forced!.push(step)
  w.faults([step])
}
const force = (S: SeedState, within: number): void => {
  if (mode === 'calm' || S.forced !== null) return
  S.forced = []
  const w = S.w
  for (const what of ['leader-change', 'move'] as const) {
    w.after(S.rng.range(0, within), null, `forced-${what}`, () => {
      const k = w.kernel
      const live = k ? w.history.filter((o: any) => o.t1 === undefined && WRITES.has(o.op) && rowKeyOf(o) !== undefined && k.meta(o.res) && w.proc(o.proc).alive) : []
      if (live.length === 0) { S.pending.push(what); return }
      aim(S, what, live[S.rng.int(live.length)])
    })
  }
}
const onRecord = (S: SeedState, op: any): void => {
  if (S.pending.length === 0 || !WRITES.has(op.op) || rowKeyOf(op) === undefined) return
  for (const what of S.pending.splice(0)) S.w.after(S.rng.range(0.05, 0.6), null, `forced-${what}`, () => aim(S, what, op))
}

// ── analysis of one seed ───────────────────────────────────────────────────────────────────────
const vcmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const analyse = (S: SeedState): void => {
  const w = S.w, k = w.kernel
  const H: any[] = w.history
  const direct: Record<string, number> = { once: 0, refusal: 0, acked: 0, kept: 0, 'fence-log': 0, 'fence-rt': 0, session: 0 }
  const ex: string[] = []
  const bad = (kind: string, msg: string): void => { direct[kind]++; if (ex.length < 6) ex.push(`${kind}: ${msg}`) }
  const out: SeedOut = { seed: S.seed, cover: { lcInFlight: false, moveInFlight: false, elections: S.elections.length, lost: 0, moves: 0, movesDone: 0, forced: S.forced ? [...S.forced.map((f) => f.do + (f.missed ? ' missed' : '')), ...S.pending.map((x) => `${x} missed`)].join('+') : 'none', dedup: 0, mutantHits: S.hits }, direct, directEx: ex, kv: { parts: 0, ops: 0, skipped: {} } }
  outs.push(out)
  if (!k) return
  if (process.env.E22_DUMP) for (const g of k.meta(process.env.E22_DUMP)?.groups ?? []) {
    console.log(`DUMP ${g.id} leader ${g.leader} term ${g.term} base ${g.base} commit ${g.commit} last ${g.last} voters ${g.voters}`)
    for (let i = g.base + 1; i <= g.last; i++) { const e = g.entry(i); console.log(`  ${i} t${e.term} ${e.k} p=${e.p} a=${e.a ?? ''} v=${e.v} why=${e.why ?? ''} recs=${JSON.stringify(e.recs).slice(0, 160)} m=${JSON.stringify(e.m ?? {}).slice(0, 200)}`) }
  }
  out.cover.lost = S.elections.reduce((n, e) => n + e.lost, 0)
  out.cover.dedup = internalsStack(w).l2.stats.dedup
  out.cover.moves = k.moves.length
  out.cover.movesDone = k.moves.filter((m: any) => m.done !== undefined).length

  // coverage: a fault lands while a client operation on the same resource is in flight
  const byRes = new Map<string, any[]>()
  for (const op of H) if (op.t1 !== undefined) { let xs = byRes.get(op.res); if (!xs) byRes.set(op.res, (xs = [])); xs.push(op) }
  out.cover.lcInFlight = S.elections.some((e) => (byRes.get(e.res) ?? []).some((o) => o.t0 < e.t && e.t < o.t1))
  out.cover.moveInFlight = k.moves.some((m: any) => (byRes.get(m.res) ?? []).some((o) => o.t0 < (m.done ?? w.time) && m.at < o.t1))

  const metaOf = (res: string): any => k.meta(res)
  // 'none' is lossy by design (it commits at the writer alone); streams (rows: false) are checked
  const lossy = (res: string): boolean => { const m = metaOf(res); return !m || m.opts.durability === 'none' }

  // committed entries, by (res, attempt)
  const capsBy = new Map<string, Cap[]>()
  for (const c of S.commits) {
    if (c.e.a === undefined || (c.e.k !== 'w')) continue
    const key = `${c.res}\u0000${c.e.a}`
    let xs = capsBy.get(key); if (!xs) capsBy.set(key, (xs = [])); xs.push(c)
  }
  // once: no attempt commits twice in one resource
  for (const [key, xs] of capsBy) if (xs.length > 1 && !lossy(xs[0].res)) bad('once', `${key.replace('\u0000', ' ')} committed ${xs.length} times`)
  // kept: every committed entry is still in its group's log (unless compacted or a 'none' resource)
  for (const c of S.commits) {
    if (lossy(c.res)) continue
    const g = k.group?.(c.g) ?? metaOf(c.res)?.groups.find((x: any) => x.id === c.g)
    if (!g || c.i <= g.base) continue
    const now = g.entry(c.i)
    if (!now || now !== c.e) bad('kept', `${c.g} index ${c.i} (${c.e.k} ${c.e.a ?? ''}) committed at ${c.tC.toFixed(3)}, gone later`)
  }
  // client write ops, by (res, attempt)
  const opsBy = new Map<string, any[]>()
  for (const op of H) {
    if (!WRITES.has(op.op) || op.a === undefined) continue
    const key = `${op.res}\u0000${op.a}`
    let xs = opsBy.get(key); if (!xs) opsBy.set(key, (xs = [])); xs.push(op)
  }
  for (const [key, ops] of opsBy) {
    const caps = capsBy.get(key) ?? []
    const res = ops[0].res
    if (ops.length === 1 && ops[0].outcome === 'refused' && ops[0].code !== 'call-diverged' && caps.length > 0) bad('refusal', `${key.replace('\u0000', ' ')} refused '${ops[0].code}' but committed at ${caps[0].tC.toFixed(3)}`)
    if (lossy(res)) continue
    for (const op of ops) {
      if (!op.ok || op.v === undefined || op.v === '') continue
      if (caps.length === 0) bad('acked', `${key.replace('\u0000', ' ')} acknowledged ${op.v} at ${op.t1.toFixed(3)}, not in the log`)
      else if (!caps.some((c) => c.e.v === op.v)) bad('acked', `${key.replace('\u0000', ' ')} acknowledged ${op.v}, committed as ${caps.map((c) => c.e.v)}`)
    }
  }
  // fence-log: per group, in commit order, tokens per lock never go back
  const perGroup = new Map<string, Cap[]>()
  for (const c of S.commits) { let xs = perGroup.get(c.g); if (!xs) perGroup.set(c.g, (xs = [])); xs.push(c) }
  for (const [gid, cs] of perGroup) {
    const hi = new Map<string, string>()
    for (const c of cs) {
      if (c.e.k === 'in') for (const [l, tok] of c.e.m?.slot?.fences ?? []) if ((hi.get(l) ?? '') < tok) hi.set(l, tok)
      const f = c.e.m?.fence
      if (!f) continue
      const [l, tok] = f
      if (tok < (hi.get(l) ?? '')) bad('fence-log', `${gid} index ${c.i}: a write under ${tok} after one under ${hi.get(l)} (lock ${l})`)
      if (tok > (hi.get(l) ?? '')) hi.set(l, tok)
    }
  }
  // fence-rt: a fenced write that started after a newer token's write was acknowledged must fail
  const fenced = H.filter((o) => WRITES.has(o.op) && Array.isArray(o.w) && o.w.some((x: any) => x.if?.fence)).map((o) => ({ o, f: o.w.find((x: any) => x.if?.fence).if.fence }))
  for (const a of fenced) {
    if (!a.o.ok) continue
    for (const b of fenced) {
      if (b === a || !b.o.ok || b.f.lock !== a.f.lock || !(b.f.token > a.f.token)) continue
      if (b.o.t1 < a.o.t0) { bad('fence-rt', `lock ${a.f.lock}: ${a.o.res} write under ${a.f.token} started ${a.o.t0.toFixed(3)}, after one under ${b.f.token} was acknowledged at ${b.o.t1.toFixed(3)}`); break }
    }
  }
  // session: per process and row, plain reads never go back, and see the process's own writes
  {
    const last = new Map<string, { v: string; t1: number }[]>()
    const ordered = H.filter((o) => o.t1 !== undefined && o.ok).sort((a, b) => a.t0 - b.t0)
    for (const o of ordered) {
      if (lossy(o.res)) continue
      const isRead = o.op === 'get', isWrite = o.op === 'set' || o.op === 'batch' || o.op === 'remove'
      if (!isRead && !isWrite) continue
      const rk = isRead ? String(o.key[0]) : rowKeyOf(o)
      if (rk === undefined || !o.v) continue
      const key = `${o.proc}\u0000${o.res}\u0000${rk}`
      const prev = (last.get(key) ?? []).filter((p) => p.t1 < o.t0)
      if (isRead) {
        const floor = prev.reduce((m, p) => (vcmp(p.v, m) > 0 ? p.v : m), '')
        if (vcmp(o.v, floor) < 0 && o.v !== '') bad('session', `${o.proc} read ${o.res}/${rk} at version ${o.v} after it had seen ${floor}`)
      }
      let xs = last.get(key); if (!xs) last.set(key, (xs = [])); xs.push({ v: o.v, t1: o.t1 })
    }
  }

  // ── the per-partition histories for Porcupine ──────────────────────────────────────────────────
  if (!histOut) return
  const parts = new Map<string, { res: string; p: string; vals: boolean; ops: any[] }>()
  const skipped: Record<string, number> = {}
  const partOf = (res: string, p: string) => {
    const key = `${res}\u0000${p}`
    let x = parts.get(key)
    if (!x) {
      const m = metaOf(res)
      const shaped = (m?.shapes ?? []).some((s: [number, number][]) => s.some(([, v]) => v > 1)) || m?.code?.up !== undefined
      parts.set(key, (x = { res, p, vals: !shaped, ops: [] }))
    }
    return x
  }
  const usable = (res: string): boolean => {
    const m = metaOf(res)
    const why = !m ? 'dropped' : m.opts.rows === false ? 'stream (rows: false)' : m.opts.durability === 'none' ? "durability 'none'" : null
    if (why) { skipped[why] = (skipped[why] ?? 0) + 1; return false }
    return true
  }
  const entryOp = (c: Cap, call: number, ret: number) => ({
    c: call, r: ret, kind: 'e',
    in: { recs: c.e.recs.map((r: any) => ({ t: r.type, k: r.key, v: r.value })), bump: [...Object.keys(c.e.m?.claims ?? {}), ...Object.keys(c.e.m?.ttl ?? {})] },
    out: { v: c.e.v }, why: c.e.k === 'x' ? `x:${c.e.why}` : 'w',
  })
  const usedCaps = new Set<Cap>()
  for (const [key, ops] of opsBy) {
    const res = ops[0].res
    if (!usable(res)) continue
    const meta = metaOf(res)
    const caps = capsBy.get(key) ?? []
    for (const c of caps) usedCaps.add(c)
    const rk = rowKeyOf(ops[0])
    if (rk === undefined) continue
    const P = partOf(res, k.partitionOf(meta, rk))
    const okOps = ops.filter((o) => o.ok)
    const call = Math.min(...ops.map((o) => o.t0))
    if (okOps.length > 0) {
      const o = okOps[0]
      const ret = Math.min(...okOps.map((x) => x.t1))
      if (o.op === 'claim') P.ops.push({ c: call, r: ret, kind: 'claim', in: {}, out: { v: o.v ?? '', rows: ((o.value as any)?.rows ?? []).map((r: any) => String(r.key)) } })
      else if (o.op === 'touch') P.ops.push({ c: call, r: ret, kind: 'touch', in: { key: String(o.touch.key), ttl: o.touch.ttl !== undefined || o.touch.lease !== undefined, if: o.touch.if ?? null }, out: { v: o.v ?? '' } })
      else P.ops.push({ c: call, r: ret, kind: 'w', in: { ws: o.w.map((x: any) => ({ k: x.key, v: x.value, op: x.op ?? null, rm: !!x.remove, if: x.if ?? null })) }, out: { ok: true, v: o.v ?? '', ans: o.value === undefined ? null : o.value, hasAns: o.value !== undefined } })
    } else if (caps.length > 0) {
      P.ops.push(entryOp(caps[0], call, INF))
    } else if (ops.length === 1 && ops[0].outcome === 'refused' && ['conflict', 'absent-row', 'absent-path'].includes(ops[0].code)) {
      const o = ops[0]
      if (o.op === 'touch') P.ops.push({ c: o.t0, r: o.t1, kind: 'touch', in: { key: String(o.touch.key), ttl: true, if: o.touch.if ?? null }, out: { code: o.code } })
      else if (o.op !== 'claim') P.ops.push({ c: o.t0, r: o.t1, kind: 'w', in: { ws: o.w.map((x: any) => ({ k: x.key, v: x.value, op: x.op ?? null, rm: !!x.remove, if: x.if ?? null })) }, out: { ok: false, code: o.code } })
    }
  }
  // writer-made entries (ttl, max, where, session) and any entry no client op accounts for
  for (const c of S.commits) {
    if (usedCaps.has(c) || (c.e.k !== 'w' && c.e.k !== 'x')) continue
    if (c.e.k === 'w' && c.e.a !== undefined && opsBy.has(`${c.res}\u0000${c.e.a}`)) continue
    if (!usable(c.res)) continue
    partOf(c.res, c.e.p).ops.push(entryOp(c, c.tA, c.tC))
  }
  // linearizable reads
  for (const o of H) {
    if (o.op !== 'get-fresh' || !o.ok || !usable(o.res)) continue
    const meta = metaOf(o.res)
    const P = partOf(o.res, k.partitionOf(meta, String(o.key[0])))
    P.ops.push({ c: o.t0, r: o.t1, kind: 'r', in: { k: o.key }, out: { v: o.v ?? '', has: o.value !== undefined, val: o.value === undefined ? null : o.value } })
  }
  const list = [...parts.values()].filter((x) => x.ops.length > 0)
  out.kv = { parts: list.length, ops: list.reduce((n, x) => n + x.ops.length, 0), skipped }
  appendFileSync(histOut, JSON.stringify({ check: base, mode, mutant: mutant ?? null, seed: S.seed, parts: list }) + '\n')
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────
if (histOut) writeFileSync(histOut, '')
const mod = await import(pathToFileURL(file).href)
const t0 = performance.now()
let finished = false
// a world that goes idle with a promise pending never ends its seed: Node would exit with code 13
// (an unsettled top-level await). Report it as a failed seed, with what ran before it.
process.on('beforeExit', () => {
  if (finished) return
  const S = states[states.length - 1]
  finish(`HUNG ${base}: seed ${S?.seed} never finished (its world went idle with a client promise pending)`, [S?.seed ?? -1], [`seed ${S?.seed}: hung`], process.env.E22_NAME)
  process.exit(1)
})
const finish = (line: string, failedSeeds: number[], errors: string[], name?: string): void => {
  finished = true
  const ms = performance.now() - t0
  const n = outs.length
  const sum = (f: (o: SeedOut) => number): number => outs.reduce((a, o) => a + f(o), 0)
  const direct: Record<string, number> = {}
  for (const o of outs) for (const [k2, v] of Object.entries(o.direct)) direct[k2] = (direct[k2] ?? 0) + v
  const directEx = outs.flatMap((o) => o.directEx.map((x) => `seed ${o.seed}: ${x}`)).slice(0, 10)
  const summary = {
    check: base, name: name ?? base.replace(/\.check\.ts$/, ''), mode, mutant: mutant ?? null, line, worlds: n, failedSeeds, errors, ms: Math.round(ms),
    cover: { lcInFlight: outs.filter((o) => o.cover.lcInFlight).length, moveInFlight: outs.filter((o) => o.cover.moveInFlight).length, elections: sum((o) => o.cover.elections), lost: sum((o) => o.cover.lost), moves: sum((o) => o.cover.moves), movesDone: sum((o) => o.cover.movesDone), forced: outs.filter((o) => o.cover.forced !== 'none' && !o.cover.forced.includes('missed')).length, dedup: sum((o) => o.cover.dedup), mutantHits: sum((o) => o.cover.mutantHits) },
    direct, directEx,
    kv: { parts: sum((o) => o.kv.parts), ops: sum((o) => o.kv.ops) },
  }
  console.log(`${line}; ${mode}${mutant ? ` mutant ${mutant}` : ''}; ${n} worlds; LC in flight ${summary.cover.lcInFlight}/${n}, move in flight ${summary.cover.moveInFlight}/${n}; ${summary.cover.elections} elections, ${summary.cover.lost} lost, ${summary.cover.movesDone}/${summary.cover.moves} moves, forced ${summary.cover.forced}/${n}, ${summary.cover.dedup} dedup${mutant ? `, ${summary.cover.mutantHits} mutant hits` : ''}; direct ${JSON.stringify(direct)}; ${(ms / 1000).toFixed(1)} s`)
  for (const e of errors) console.log(`  ${e}`)
  for (const e of directEx) console.log(`  ${e}`)
  if (jsonOut) appendFileSync(jsonOut, JSON.stringify(summary) + '\n')
}
if (base === 'core-determinism.check.ts') {
  const n = Number(flag('--seeds') ?? 100)
  try {
    const r = await mod.run(n)
    const ok = r.same === r.seeds && r.distinct === r.seeds
    finish(ok ? `ok core-determinism (${r.seeds} seeds run twice: identical; ${r.distinct} distinct)` : `FAILED core-determinism: ${r.same}/${r.seeds} identical, ${r.distinct} distinct`, ok ? [] : [-1], [], 'core-determinism')
  } catch (e) { finish(`FAILED core-determinism: ${(e as Error).message}`, [-1], []) }
} else {
  const r = await mod.run()
  const errors = r.failed.slice(0, 8).map((f: any) => `seed ${f.seed}: ${f.error.split('\n')[0].slice(0, 300)}${f.faults?.length ? ` [faults: ${f.faults.join(' | ').slice(0, 300)}]` : ''}`)
  finish(r.failed.length === 0 ? `ok ${r.name} (${r.seeds} seeds)` : `FAILED ${r.name}: ${r.failed.length} of ${r.seeds} seeds`, r.failed.map((f: any) => f.seed), errors, r.name)
}
