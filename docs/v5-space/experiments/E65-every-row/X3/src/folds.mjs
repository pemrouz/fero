// E-65 X3: folds written as an app author would write them, over rows { id, points, room } (E-23's dirty domain:
// numbers, two-decimal values, null, strings, NaN, the infinities, objects; rooms 'r0'..'r49', 1..5 and '1'..'5').
// makeFolds(version) gives the six lawful folds at code version 1 or 2 (a deploy changes each a little).
// userBug(name) gives one fold with a mistake an author could make.
import { fold } from './fold.mjs'
import { num, cmpStr } from './lib.mjs'

const fin = (x) => { const v = num(x); return v !== undefined && Number.isFinite(v) && Math.abs(v) < 1e9 ? v : undefined }
const cents = (x) => { const v = fin(x); return v === undefined ? undefined : Math.round(v * 100) }
// the bucket is the room as it is: 1 and '1' are two buckets (fero keys buckets by type, C10)
const room = (row) => (row.room === undefined ? null : row.room)
const h32 = (s) => { let h = 0x9e3779b1; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x85ebca77) } h ^= h >>> 15; h = Math.imul(h, 0xc2b2ae3d); return (h ^ (h >>> 13)) >>> 0 }
const byScore = (a, b) => (b[0] - a[0]) || cmpStr(a[1], b[1]) // score down, then key: a total order (C1)
const topMerge = (K) => (a, b) => { const out = a.concat(b).sort(byScore); out.length = Math.min(out.length, K); return out }

export function makeFolds(v = 1) {
  return [
    // count and exact sum (in cents, as integers) per room: a group with an inverse
    fold({ name: 'roomStats', version: v,
      emit: (row) => { const c = cents(row.points) ?? 0; return [[room(row), [1, v === 1 ? c : Math.max(c, 0)]]] },
      empty: () => [0, 0], combine: (a, b) => [a[0] + b[0], a[1] + b[1]], remove: (a, b) => [a[0] - b[0], a[1] - b[1]],
      done: (p) => ({ n: p[0], avg: p[1] / p[0] / 100 }) }),
    // a histogram of points, bins of 10 (20 after the deploy)
    fold({ name: 'hist', version: v,
      emit: (row) => { const x = fin(row.points); return x === undefined ? [] : [[Math.floor(x / (v === 1 ? 10 : 20)) * (v === 1 ? 10 : 20), 1]] },
      empty: () => 0, combine: (a, b) => a + b, remove: (a, b) => a - b }),
    // the distinct point values over every row: a multiset (value -> rows), so a value can leave; set union
    fold({ name: 'distinct', version: v,
      map: (row) => { const x = fin(row.points); return x === undefined ? undefined : new Map([[v === 1 ? x : Math.trunc(x), 1]]) },
      empty: () => new Map(),
      combine: (a, b) => { for (const [x, n] of b) a.set(x, (a.get(x) ?? 0) + n); return a },
      remove: (a, b) => { for (const [x, n] of b) { const m = a.get(x) - n; if (m === 0) a.delete(x); else a.set(x, m) } return a },
      done: (p) => [...p.keys()].sort((x, y) => x - y) }),
    // the largest points per room: a monoid with no inverse (a leaving max needs a rescan)
    fold({ name: 'maxByRoom', version: v,
      emit: (row) => { const x = fin(row.points); return x === undefined ? [] : [[room(row), v === 1 ? x : Math.round(x)]] },
      empty: () => -Infinity, combine: (a, b) => Math.max(a, b),
      keeps: (acc, x) => x < acc }), // a value below the max can leave without changing it
    // the best 3 rows (4 after the deploy) by a user score, ties by key: a top k by code
    fold({ name: 'top', version: v,
      map: (row) => { const x = fin(row.points); return x === undefined ? undefined : [[x * 2 - String(room(row)).length, row.id]] },
      empty: () => [], combine: topMerge(v === 1 ? 3 : 4),
      keeps: (acc, e) => acc.length === (v === 1 ? 3 : 4) && byScore(e[0], acc[acc.length - 1]) > 0 }), // ranked below the k-th
    // a 64-register HyperLogLog of row keys: a mergeable sketch (approximate distinct count), no inverse
    fold({ name: 'hll', version: v,
      map: (row) => { const h = h32(row.id + (v === 1 ? '' : '#')), r = new Array(64).fill(0); r[h & 63] = Math.clz32((h >>> 6) | 1) - 5; return r },
      empty: () => new Array(64).fill(0),
      combine: (a, b) => { for (let i = 0; i < 64; i++) if (b[i] > a[i]) a[i] = b[i]; return a },
      keeps: (acc, r) => { for (let i = 0; i < 64; i++) if (r[i] > 0) return r[i] < acc[i]; return true },
      done: (p) => Math.round(0.709 * 64 * 64 / p.reduce((s, x) => s + 2 ** -x, 0)) }),
  ]
}

// Mistakes an author could make. Each is checked three ways: the oracle (is the live answer what one process
// folding every row would give?), fero's self-check at build, and fero's audit while it runs.
export function userBug(name) {
  switch (name) {
    // an average kept as (n, mean) and combined as the mean of means: not associative
    case 'avgmeans': return fold({ name, map: (row) => { const x = fin(row.points); return x === undefined ? undefined : [1, x] },
      empty: () => [0, 0], combine: (a, b) => (a[0] === 0 ? b.slice() : b[0] === 0 ? a : [a[0] + b[0], (a[1] + b[1]) / 2]) })
    // "a room for each bin": keep the first one seen. Not commutative: the answer depends on who came first
    case 'firstwins': return fold({ name, emit: (row) => { const x = fin(row.points); return x === undefined ? [] : [[Math.floor(x / 10), String(room(row))]] },
      empty: () => '', combine: (a, b) => (a === '' ? b : a) })
    // a sum of points as plain floats, with subtract to remove: not associative in floating point, and drifts
    case 'floatsum': return fold({ name, emit: (row) => { const x = fin(row.points); return x === undefined ? [] : [[room(row), x]] },
      empty: () => 0, combine: (a, b) => a + b, remove: (a, b) => a - b })
    // remove forgets the sum: it does not undo combine
    case 'badremove': return fold({ name, emit: (row) => [[room(row), [1, cents(row.points) ?? 0]]],
      empty: () => [0, 0], combine: (a, b) => [a[0] + b[0], a[1] + b[1]], remove: (a, b) => [a[0] - b[0], a[1]] })
    // a max declared with a remove that does nothing ("removing cannot raise a max")
    case 'maxremove': return fold({ name, emit: (row) => { const x = fin(row.points); return x === undefined ? [] : [[room(row), x]] },
      empty: () => -Infinity, combine: (a, b) => Math.max(a, b), remove: (a) => a })
    // a max whose hint says a value EQUAL to the max can leave without changing it (wrong for the last such value)
    case 'badkeeps': return fold({ name, emit: (row) => { const x = fin(row.points); return x === undefined ? [] : [[room(row), x]] },
      empty: () => -Infinity, combine: (a, b) => Math.max(a, b), keeps: (acc, x) => x <= acc })
    // a score that reads module state (a counter): emit is not a function of the row
    case 'impure': { let calls = 0
      return fold({ name, map: (row) => { const x = fin(row.points); return x === undefined ? undefined : [[x + (calls++ % 3), row.id]] },
        empty: () => [], combine: topMerge(3) }) }
    // a count whose empty is 1, not 0
    case 'badempty': return fold({ name, emit: (row) => { const x = fin(row.points); return x === undefined ? [] : [[Math.floor(x / 10) * 10, 1]] },
      empty: () => 1, combine: (a, b) => a + b, remove: (a, b) => a - b })
    // a set union that adds into its SECOND argument and returns it
    case 'mutsecond': return fold({ name, map: (row) => { const x = fin(row.points); return x === undefined ? undefined : new Map([[x, 1]]) },
      empty: () => new Map(),
      combine: (a, b) => { for (const [x, n] of a) b.set(x, (b.get(x) ?? 0) + n); return b },
      remove: (a, b) => { for (const [x, n] of b) { const m = a.get(x) - n; if (m === 0) a.delete(x); else a.set(x, m) } return a },
      done: (p) => [...p.keys()].sort((x, y) => x - y) })
  }
  throw new Error('no such bug ' + name)
}
export const USER_BUGS = ['avgmeans', 'firstwins', 'floatsum', 'badremove', 'maxremove', 'badkeeps', 'impure', 'badempty', 'mutsecond']
