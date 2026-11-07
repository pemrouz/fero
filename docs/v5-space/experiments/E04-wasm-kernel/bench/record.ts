// Record the kernel calls of 200 K chaos seeds (the TS twin; the WASM twin's calls are the same
// bytes, by the guard) into one trace file for the replay benches.
// node --experimental-strip-types bench/record.ts <out file>
import { writeFileSync } from 'node:fs'
import { tsKernel, W } from '../k-ts/k.ts'
import { runSeed } from '../sim/simk.ts'

const w = new W()
const rec = {
  create(id: number, n: number, j: Uint8Array) { w.u8(0); w.varint(id); w.varint(n); w.varint(j.length); w.bytes(j) },
  step(slot: number, ev: Uint8Array) { w.u8(1); w.varint(slot); w.varint(ev.length); w.bytes(ev) },
  destroy(slot: number) { w.u8(2); w.varint(slot) },
}
// slots are global across seeds: runSeed numbers them per seed, so offset them here
let base = 0, maxSlot = 0
const wrap = {
  create: (id: number, n: number, j: Uint8Array) => { rec.create(id, n, j); maxSlot++ },
  step: (slot: number, ev: Uint8Array) => rec.step(base + slot, ev),
  destroy: (slot: number) => rec.destroy(base + slot),
}
const K = tsKernel()
let events = 0
for (let s = 1; s <= 200; s++) { base = maxSlot; const r = runSeed(K, s, { record: wrap, ticks: Number(process.env.TICKS ?? 130) }); events += r.events }
writeFileSync(process.argv[2], w.take())
console.log(JSON.stringify({ trace: process.argv[2], bytes: w.len, events }))
