const P = new URL('../proto/lens.mjs', import.meta.url).href
const { fero, Loop } = await import(P)
const seed = {}; for (let i = 0; i < 100000; i++) seed['k' + i] = { n: i, s: 'x'.repeat(40) }
const srv = fero('s', { data: seed })
const tr = new Loop(srv); const cl = fero('s', { role: 'client', transport: tr })
async function open() { return cl.data }           // an ordinary helper that hands back the lens
const t0 = performance.now(); const x = await open(); const ms = performance.now() - t0
const v = typeof x === 'function' ? 'a lens (nothing was read)' : x instanceof Map ? x.size : typeof x === 'object' ? Object.keys(x ?? {}).length : typeof x
console.log(JSON.stringify({ returnedType: typeof x, rowsInAnswer: v, gets: tr.stats.gets, ms: +ms.toFixed(1), bytesIfJSON: typeof x === 'function' ? 0 : JSON.stringify(x instanceof Map ? Object.fromEntries(x) : x)?.length }))
