// Does data v4 tie a subscription's life to its anchor? (api/index.ts:357-360 ignores the anchor argument.)
// An anchor is dropped by the program; after full GCs: is the anchor collected, and does the subscription still fire?
//   node --expose-gc anchor-life.mjs   (TREE = the E-50 scratch tree)
import { pathToFileURL } from 'node:url'
const D = await import(pathToFileURL(process.env.TREE + '/data/api/index.ts').href)
const gc = async () => { for (let i = 0; i < 4; i++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 10)) } }
const s = D.$({ a: { n: 1 } })
let firedClosing = 0, firedFree = 0
let refClosing, refFree
;(() => {
  const anchor1 = { el: 'a DOM node stand-in' }
  refClosing = new WeakRef(anchor1)
  s.connect(anchor1, (r) => { anchor1.last = r; firedClosing++ })     // the callback closes over its anchor
  const anchor2 = { el: 'another stand-in' }
  refFree = new WeakRef(anchor2)
  s.connect(anchor2, () => { firedFree++ })                           // the callback does not touch its anchor
})()
await gc()
s.a.n.update(2)
console.log(JSON.stringify({ bench: 'anchor-life', node: process.version,
  closingAnchorCollected: refClosing.deref() === undefined, closingSubFiredAfterDrop: firedClosing > 1,
  freeAnchorCollected: refFree.deref() === undefined, freeSubFiredAfterDrop: firedFree > 1 }))
