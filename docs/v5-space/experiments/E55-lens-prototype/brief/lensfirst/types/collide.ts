// file: collide.ts — a field named like a verb, and assignment
import { fero } from 'fero-lens'
const f = await fero<Record<string, { set: number; filter: string; n: number }>>('f')
const a = f.data.k.set                       // the field 'set' as a step AND the verb, in one type
await a.get()                                // step: a lens on the field
await f.data.k.set({ set: 1, filter: 'x', n: 2 })   // call: the verb on the row
await f.data.k.set.set(5)                    // the field named 'set', set to 5
const n: number | undefined = f.data.k.n.peek()
// @ts-expect-error TypeScript cannot type "read a lens, assign a value" on a mapped type: typed code uses set()
f.data.k = { set: 1, filter: 'x', n: 2 }
const u = await fero('u')                    // untyped
u.data.anything.goes.set(1)
console.log(n)
