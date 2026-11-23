// E-66 probe: if `data` 5 kept a source's rows in columns "behind the same keySlot map" (data's own comment,
// kernel/store.ts), the keys would stay on the V8 heap in a `Map`. Does that keep the long pause E-65 measured
// for rows held as objects? This loads N keys and the eight-field rows into columns, three ways, then times three
// forced full collections in a row (as E-65's forced-gc probe did for one data source: 203 to 260 ms at 1e6 rows,
// 943 to 1,335 ms at 5e6).
//   map    keys in a JavaScript Map (key -> id), fields in typed-array columns (X1's ColumnStore, its own
//          typed-array index kept too, so the columns are the same)
//   ix     X1's ColumnStore alone: keys as bytes in a hash table of typed arrays; nothing per row on the V8 heap
//   keys   only the Map of keys, no columns: the part of `map` that is on the V8 heap
//   node --expose-gc --max-old-space-size=3000 keymap-gc.mjs --form=map|ix|keys --rows=5000000
import { args, out, inserts, loadavg } from '../../E65-every-row/X1/src/lib.mjs'
import { ColumnStore } from '../../E65-every-row/X1/src/compact.mjs'
import v8 from 'node:v8'

const A = args(), N = A.rows ?? 1e6, form = A.form ?? 'map'
let cs = null, m = null
if (form !== 'keys') { cs = new ColumnStore({ cap: N }); for (const b of inserts(N)) cs.apply(b) }
if (form === 'map') { m = new Map(); const ix = cs.ix; for (let id = 0; id < ix.next; id++) if (cs.pres[id]) m.set(ix.keyOf(id), id) }
if (form === 'keys') { m = new Map(); for (let j = 0; j < N; j++) m.set('k' + j, j) }
const ms = []
for (let i = 0; i < 3; i++) { const t = performance.now(); globalThis.gc(); ms.push(+(performance.now() - t).toFixed(1)) }
const h = v8.getHeapStatistics(), mu = process.memoryUsage()
out({ exp: 'E-66', probe: 'keymap-gc', form, rows: N, forced_gc_ms: ms, heap_used_mb: Math.round(h.used_heap_size / 2 ** 20), off_heap_mb: Math.round((mu.arrayBuffers + mu.external) / 2 ** 20), rss_mb: Math.round(mu.rss / 2 ** 20), live: cs ? cs.count() : m.size, node: process.version, loadavg: loadavg() })
