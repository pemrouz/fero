// What one message write costs when a room is one row (room.m = msg: a field write, path-copy of the row) against a
// row per message ('room/m' = msg). data's path-copy law copies every object on the written path (kernel/node.ts:275-291).
//   node --expose-gc nest-cost.mjs <messages per room>   (TREE = the E-50 scratch tree)
import { pathToFileURL } from 'node:url'
const D = await import(pathToFileURL(process.env.TREE + '/data/api/index.ts').href)
const M = +process.argv[2], ROOMS = 20, W = Math.max(2000, Math.min(100000, 2e7 / M))
const msg = (i) => ({ text: 'hello ' + i, at: i })
const gc = () => { globalThis.gc(); globalThis.gc() }
const time = (fn) => { const r = []; for (let k = 0; k < 5; k++) { gc(); const t0 = process.hrtime.bigint(); fn(k); r.push(Number(process.hrtime.bigint() - t0) / W) } r.sort((a, b) => a - b); return +r[2].toFixed(0) }
// nested: ROOMS rows, each with M fields
const nested = {}; for (let r = 0; r < ROOMS; r++) { const room = {}; for (let m = 0; m < M; m++) room['m' + m] = msg(m); nested['r' + r] = room }
const a = D.$(nested); a.promote()
// flat: ROOMS*M rows
const flat = {}; for (let r = 0; r < ROOMS; r++) for (let m = 0; m < M; m++) flat['r' + r + '/m' + m] = msg(m)
const b = D.$(flat); b.promote()
const nestedNs = time((k) => { for (let i = 0; i < W; i++) a.get('r' + (i % ROOMS)).set('m' + (i % M), msg(k * W + i + 1e9)) })
const flatNs = time((k) => { for (let i = 0; i < W; i++) b.set('r' + (i % ROOMS) + '/m' + (i % M), msg(k * W + i + 1e9)) })
console.log(JSON.stringify({ bench: 'nest-cost', node: process.version, messagesPerRoom: M, writes: W, nsPerWrite: { 'room row, field write': nestedNs, 'row per message': flatNs } }))
