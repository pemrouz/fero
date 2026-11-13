// B1: what one write and one inbound record cost at fero v4's API boundary, on a solo runtime (no I/O).
// Reuses fero v4's own code (copied into $TREE by ../../tree.sh, unchanged): shell/runtime.ts, api/data.ts (Bind),
// and data's lane behind api/substrate.ts. Mirrors api/data.perf.ts's two probes (api.write-5k, api.inbound-5k),
// with a second value shape: E-05's small row (about 100 B) besides a number.
//   node --experimental-strip-types --no-warnings --expose-gc api.ts <mode> [n] [rounds]
//   mode: write-num | write-row | inbound-num | inbound-row | alloc-write-num | alloc-write-row | alloc-inbound-num | alloc-inbound-row
// Prints one JSON line.
// TREE is the folder ../../tree.sh built: fero v4's api/, kernel/, shell/ and utils/ copied unchanged, data linked beside.
const TREE = process.env.TREE
if (!TREE) throw new Error('set TREE to the folder tree.sh built (run.sh does this)')
const { Runtime } = await import(TREE + '/fero/shell/runtime.ts')
const { Bind } = await import(TREE + '/fero/api/data.ts')
const { VERB, encodeControl, encodeRuns } = await import(TREE + '/fero/kernel/codec.ts')
const { REC } = await import(TREE + '/fero/kernel/env.ts')
type Rec = { type: number; key: unknown[]; value?: unknown; at?: unknown }
import { PerformanceObserver } from 'node:perf_hooks'
import v8 from 'node:v8'
import inspector from 'node:inspector'
import fs from 'node:fs'

const mode = process.argv[2] ?? 'write-num'
const N = Number(process.argv[3] ?? 20000)
const ROUNDS = Number(process.argv[4] ?? 7)
const ROWS = 1024

let v = 0
const row = () => ({ name: 'user' + (++v), email: 'u' + v + '@example.com', region: 'eu-west', room: 'r' + (v & 63), n: v, active: (v & 1) === 0, tags: ['a', 'b'] })
const valueOf = mode.endsWith('row') ? row : () => ++v

const harness = () => {
  const rt = new Runtime({ uuid: 'aa', heartbeatMs: 0 } as any)
  return { rt, bind: new Bind(rt) }
}

// inbound: a node that has admitted one peer 'bb'; frames of 50 records from bb, advancing seqs (the fresh path)
const inboundSetup = () => {
  const h = harness()
  const node = h.rt.node
  node.step({ kind: 'linkUp', link: 1, dialed: true, to: 'sim:bb' } as any)
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.HELLO, { u: 'bb', i: 1, l: 'sim:bb' }) } as any)
  node.step({ kind: 'bytesIn', link: 1, bytes: encodeControl(VERB.DIGEST, { d: {}, r: 0 }) } as any)
  return h
}
let seq = 0
const frames = (n: number): Uint8Array[] => {
  const out: Uint8Array[] = []
  for (let i = 0; i < n; i += 50) {
    const recs: { rec: Rec; origin: string; seq: number; epoch: number }[] = []
    for (let k = 0; k < 50 && i + k < n; k++) recs.push({ rec: { type: REC.update, key: ['r' + ((i + k) & (ROWS - 1))], value: valueOf() }, origin: 'bb', seq: ++seq, epoch: 0 })
    out.push(encodeRuns(recs)[0])
  }
  return out
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }

const run = async () => {
  const inbound = mode.includes('inbound')
  const h = inbound ? inboundSetup() : harness()
  const { rt, bind } = h
  const d = (bind as any).data
  // pre-build values outside the timed region (the value's own construction is the program's, not fero's)
  const prepare = () => {
    if (inbound) return frames(N)
    const vals: unknown[] = new Array(N)
    for (let i = 0; i < N; i++) vals[i] = valueOf()
    return vals
  }
  const once = (input: any) => {
    if (inbound) { for (const f of input as Uint8Array[]) rt.node.step({ kind: 'bytesIn', link: 1, bytes: f } as any) }
    else { const vals = input as unknown[]; for (let i = 0; i < N; i++) d['k' + (i & (ROWS - 1))] = vals[i] }
  }
  if (mode.startsWith('alloc')) {
    // bytes allocated per op: a young generation big enough that no GC runs inside the measured loop (checked)
    let gcs = 0
    const obs = new PerformanceObserver((l) => { gcs += l.getEntries().length })
    obs.observe({ entryTypes: ['gc'] })
    const res: number[] = []
    for (let r = 0; r < ROUNDS; r++) {
      const input = prepare()
      ;(globalThis as any).gc(); (globalThis as any).gc()
      await new Promise((r) => setTimeout(r, 5))
      const g0 = gcs
      const u0 = v8.getHeapStatistics().used_heap_size
      once(input)
      const u1 = v8.getHeapStatistics().used_heap_size
      await new Promise((r) => setTimeout(r, 5))
      if (gcs === g0) res.push((u1 - u0) / N)
    }
    obs.disconnect()
    console.log(JSON.stringify({ bench: 'api', mode, n: N, rounds_clean: res.length, bytes_per_op: Math.round(median(res)), all: res.map(Math.round) }))
  } else {
    const res: number[] = []
    // every round's input is built first, so a profile (PROF=<file>) covers only the timed loops
    const inputs = Array.from({ length: ROUNDS + 1 }, prepare)
    const sess = process.env.PROF ? new inspector.Session() : null
    const post = (m: string, p?: object) => new Promise<any>((ok, no) => sess!.post(m, p ?? {}, (e: any, r: any) => (e ? no(e) : ok(r))))
    if (sess) { sess.connect(); await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 50 }) }
    for (let r = 0; r < ROUNDS + 1; r++) {
      if (sess && r === 1) await post('Profiler.start')
      const t0 = performance.now()
      once(inputs[r])
      const t1 = performance.now()
      if (r > 0) res.push(((t1 - t0) * 1e6) / N)
    }
    if (sess) { const { profile } = await post('Profiler.stop'); fs.writeFileSync(process.env.PROF!, JSON.stringify(profile)); sess.disconnect() }
    console.log(JSON.stringify({ bench: 'api', mode, n: N, rounds: ROUNDS, ns_per_op: Math.round(median(res)), min: Math.round(Math.min(...res)), max: Math.round(Math.max(...res)) }))
  }
  bind.destroy()
  await rt.destroy()
}
await run()
