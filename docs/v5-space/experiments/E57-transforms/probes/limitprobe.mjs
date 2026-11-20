// Critic probe 2: is limit(n) arrival order even when its parent is ordered? And how do za and max treat a stray string?
import { pathToFileURL, fileURLToPath } from 'node:url'
const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../data', import.meta.url))
const D = await import(pathToFileURL(DATA + '/api/index.ts').href)
const KN = await import(pathToFileURL(DATA + '/kernel/node.ts').href)
const order = (h) => [...h[D.value] instanceof Map ? h[D.value].keys() : Object.keys(h[D.value])]
const mk = (rows) => { const rt = new D.Runtime(); const s = new KN.SourceNode(rt, rows); return { rt, s, h: D.handleFor(s) } }
// 1. za('s').limit(3) against za('s', 3), after a score change that re-ranks
{
  const { s, h } = mk({ a: { s: 1 }, b: { s: 2 }, c: { s: 3 }, d: { s: 4 }, e: { s: 5 } })
  const lim = h.za('s').limit(3), win = h.za('s', 3)
  const v0 = [JSON.stringify(lim[D.value]), JSON.stringify(win[D.value])]
  s.write('a', ['s'], 10)              // a jumps to the top
  const v1 = [JSON.stringify(lim[D.value]), JSON.stringify(win[D.value])]
  console.log('za(s).limit(3) at start:', v0[0], ' za(s,3):', v0[1])
  console.log('after a.s = 10:  za(s).limit(3):', v1[0], ' za(s,3):', v1[1])
}
// 2. a stray string in a numeric column: where does it rank in za and az, and what do max and sum give?
{
  const { h } = mk({ a: { s: 5 }, b: { s: 9 }, c: { s: 'x' }, d: { s: '42' }, e: { s: null } })
  console.log('za(s,3):', JSON.stringify(h.za('s', 3)[D.value]), ' az(s,3):', JSON.stringify(h.az('s', 3)[D.value]))
  console.log('max(s):', JSON.stringify(h.max('s')[D.value]), ' sum(s):', JSON.stringify(h.sum('s')[D.value]), ' median(s):', JSON.stringify(h.median('s')[D.value]))
}
