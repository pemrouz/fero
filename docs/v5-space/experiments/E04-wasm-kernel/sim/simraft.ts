// The same chaos sim shape as simk.ts, around a real Raft library: raft-rs 0.7.0 compiled to
// WASM (every tick, message and proposal crosses into WASM; messages cross as protobuf bytes),
// and E-10's TypeScript port of etcd raft run natively (messages stay JS objects). Both use
// election tick 10, heartbeat tick 1, PreVote and CheckQuorum, and both hand every committed
// entry to data's hot lane in JS. Not a byte-identity pair: the two libraries differ (E-10).
import { readFileSync } from 'node:fs'
import { W, R, OP } from '../k-ts/k.ts'
import { mulberry32 } from './simk.ts'

const PORT = process.env.RAFT_PORT ?? '/home/user/fero/docs/v5-space/experiments/E10-raft-port/port/src/index.ts'
const P: any = await import(PORT)

export interface Hooks { send(to: number, m: any): void; apply(idx: number, data: Uint8Array): void; leader(): void }
export interface Adapter {
  name: string
  begin(seed: number, hooks: Hooks): void
  create(id: number, n: number): number
  tick(h: number): void
  step(h: number, m: any): void
  propose(h: number, data: Uint8Array): void
  crash(h: number): void
  restart(h: number): void
  end(): void
}

export const raftWasm = (mod: WebAssembly.Module, freshInstance = true): Adapter => {
  let ex: any, memory: WebAssembly.Memory, mem: Uint8Array, hooks: Hooks, inPtr = 0, inCap = 0
  // a grown memory detaches the old buffer, and a view of a detached buffer has length 0
  const view = () => (mem.length ? mem : (mem = new Uint8Array(memory.buffer)))
  const inst = () => { ex = new WebAssembly.Instance(mod, {}).exports; memory = ex.memory; mem = new Uint8Array(memory.buffer); inPtr = 0; inCap = 0 }
  if (!freshInstance) inst()
  const put = (b: Uint8Array) => { if (b.length > inCap) { inCap = Math.max(b.length, 65536); inPtr = ex.r_in(inCap) } view().set(b, inPtr) }
  const out = (len: number) => {
    if (len === 0) return
    const o = ex.r_out()
    const b = view()
    const r = new R(b, o, o + len)
    while (r.more()) {
      const tag = r.u8()
      if (tag === 0x20) { const to = r.varint(), l = r.varint(); hooks.send(to, b.slice(r.pos, r.pos + l)); r.pos += l }
      else if (tag === 0x22) { const idx = r.varint(), l = r.varint(); hooks.apply(idx, b.subarray(r.pos, r.pos + l)); r.pos += l }
      else if (tag === 0x24) { const role = r.u8(); r.varint(); r.varint(); if (role === 2) hooks.leader() }
      else if (tag === 0x25) { /* proposal dropped */ }
      else throw new Error('raft-wasm effect ' + tag)
    }
  }
  return {
    name: freshInstance ? 'raft-rs wasm (fresh instance per seed)' : 'raft-rs wasm (one instance)',
    begin(seed, h) { hooks = h; if (freshInstance) inst(); ex.r_seed(seed); ex.r_reset() },
    create: (id, n) => ex.r_create(id, n),
    tick: (h) => out(ex.r_tick(h)),
    step: (h, m: Uint8Array) => { put(m); out(ex.r_step(h, m.length)) },
    propose: (h, d) => { put(d); out(ex.r_propose(h, d.length)) },
    crash: (h) => ex.r_crash(h),
    restart: (h) => out(ex.r_restart(h)),
    end() {},
  }
}

export const raftTs = (): Adapter => {
  let hooks: Hooks
  let reps: { id: number; n: number; st: any; rn: any; leader: boolean }[] = []
  const cfg = (id: number, st: any, applied: number) => new P.Config({ ID: id, ElectionTick: 10, HeartbeatTick: 1, Storage: st, Applied: applied, MaxSizePerMsg: 1 << 20, MaxInflightMsgs: 256, PreVote: true, CheckQuorum: true, Logger: P.discardLogger })
  const ready = (r: (typeof reps)[number]) => {
    const rn = r.rn
    const isLeader = rn.raft.state === P.StateLeader
    if (isLeader && !r.leader) hooks.leader()
    r.leader = isLeader
    if (!rn.HasReady()) return
    const rd = rn.Ready()
    if (!P.IsEmptyHardState(rd.HardState)) r.st.SetHardState(rd.HardState)
    if (!P.IsEmptySnap(rd.Snapshot)) r.st.ApplySnapshot(rd.Snapshot)
    if (rd.Entries.length) r.st.Append(rd.Entries)
    for (const m of rd.Messages) hooks.send(m.GetTo(), m)
    for (const e of rd.CommittedEntries) { const d = e.GetData(); if (e.GetType() === P.pb.EntryNormal && d && d.length) hooks.apply(e.GetIndex(), d) }
    rn.Advance(rd)
  }
  return {
    name: 'etcd raft TS port (E-10)',
    begin(seed, h) {
      hooks = h; reps = []
      const rnd = mulberry32(seed ^ 0x5bd1e995)
      P.globalRand.Intn = (k: number) => Math.floor(rnd() * k)
    },
    create(id, n) {
      const st = new P.MemoryStorage()
      st.ApplySnapshot(new P.pb.Snapshot({ Metadata: new P.pb.SnapshotMetadata({ Index: 1, Term: 1, ConfState: new P.pb.ConfState({ Voters: Array.from({ length: n }, (_, i) => i + 1) }) }) }))
      reps.push({ id, n, st, rn: new P.RawNode(cfg(id, st, 1)), leader: false })
      return reps.length - 1
    },
    tick(h) { const r = reps[h]; r.rn.Tick(); ready(r) },
    step(h, m) { const r = reps[h]; r.rn.Step(m); ready(r) },
    propose(h, d) { const r = reps[h]; r.rn.Propose(d); ready(r) },
    crash(h) { reps[h].rn = null; reps[h].leader = false },
    restart(h) { const r = reps[h]; r.rn = new P.RawNode(cfg(r.id, r.st, 1)); ready(r) },
    end() {},
  }
}

const KEYS = ['a', 'b', 'c', 'user:1', 'user:2', 'café', 'ｚ', '😀', 'naïve', 'x\uD800y']

export interface RResult { events: number; applies: number; leaderChanges: number; crashes: number; violations: string[] }

export function runRaftSeed(A: Adapter, seed: number, o: { ticks?: number; fold?: any } = {}): RResult {
  const rnd = mulberry32(seed)
  const n = rnd() < 0.8 ? 3 : 5
  const T = o.ticks ?? 100
  const D = o.fold
  const h: number[] = [0], alive: boolean[] = [false], downUntil: number[] = [0], cutUntil: number[] = [0]
  const lanes: any[] = [null], srcs: any[] = [null], applied: number[] = [0]
  const buckets: { to: number; from: number; m: any }[][] = Array.from({ length: T + 8 }, () => [])
  const applyAt = new Map<number, string>()
  const violations: string[] = []
  let events = 0, applies = 0, leaderChanges = 0, crashes = 0, t = 0, cur = 0
  const recs: any[] = []
  A.begin(seed, {
    send(to, m) { if (rnd() < 0.05) return; buckets[Math.min(t + 1 + Math.floor(rnd() * 3), T + 7)].push({ to, from: cur, m }) },
    apply(idx, data) {
      const r = new R(data)
      const op = r.u8(), key = r.str(), v = op === OP.DEL ? 0 : r.f64()
      const sig = op + '|' + key + '|' + v
      const p = applyAt.get(idx)
      if (p === undefined) applyAt.set(idx, sig); else if (p !== sig) violations.push(`seed ${seed}: node ${cur} applied a different entry at ${idx}`)
      applied[cur] = idx; applies++
      if (D) { if (op === OP.SET) recs.push({ type: 0, key: [key], value: v }) }
    },
    leader() { leaderChanges++ },
  })
  const mkFold = (id: number) => { if (D) { srcs[id] = D.$({}); lanes[id] = D.lane(srcs[id], { onReject: (r: any) => { throw r.error } }) } }
  const flush = () => { if (D && recs.length) { lanes[cur](recs); recs.length = 0 } }
  for (let id = 1; id <= n; id++) { h[id] = A.create(id, n); alive[id] = true; downUntil[id] = 0; cutUntil[id] = 0; mkFold(id) }
  const w = new W()
  for (t = 0; t < T; t++) {
    if (rnd() < 0.02) { const id = 1 + Math.floor(rnd() * n); if (alive[id]) { alive[id] = false; downUntil[id] = t + 3 + Math.floor(rnd() * 10); crashes++; A.crash(h[id]) } }
    if (rnd() < 0.02) { const id = 1 + Math.floor(rnd() * n); cutUntil[id] = t + 5 + Math.floor(rnd() * 10) }
    for (let id = 1; id <= n; id++) if (!alive[id] && downUntil[id] === t) { alive[id] = true; mkFold(id); cur = id; events++; A.restart(h[id]); flush() }
    const due = buckets[t]
    for (let i = 0; i < due.length; i++) {
      const { to, from, m } = due[i]
      if (!alive[to] || cutUntil[to] > t || cutUntil[from] > t) continue
      cur = to; events++; A.step(h[to], m); flush()
    }
    if (rnd() < 0.6) {
      const id = 1 + Math.floor(rnd() * n)
      const x = rnd(), op = x < 0.9 ? OP.SET : OP.DEL
      const key = KEYS[Math.floor(rnd() * KEYS.length)]
      const v = Math.floor(rnd() * 100)
      if (alive[id]) { w.reset(); w.u8(op); w.str(key); if (op !== OP.DEL) w.f64(v); cur = id; events++; A.propose(h[id], w.take()); flush() }
    }
    for (let id = 1; id <= n; id++) if (alive[id]) { cur = id; events++; A.tick(h[id]); flush() }
  }
  A.end()
  return { events, applies, leaderChanges, crashes, violations }
}

export const compile = (path: string) => new WebAssembly.Module(readFileSync(path))
