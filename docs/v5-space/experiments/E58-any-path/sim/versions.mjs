// E-58 part 5: a version per row. `if: { version }` judges the row's version, so a guarded write on one field is
// refused when only a sibling field changed. How often, in a mixed workload?
// A seeded model of the leader (versions are the leader's, not data's, so data is not needed here): 3 rows
// { stock, price, name }; 400 steps a seed. Guarded writers read a row's stock with its version, then 1 to 6 commits
// later write stock = f(stock) with a guard. Other writers, in between: a sibling field (price or name) with the share
// given on the command line; else the same field (60 %), the whole row (25 %), or op.merge of the row (15 %).
// Three guards, judged on the same history:
//   row     if: { version }, the row's version (v5 as written)
//   field   a version per field, moved by writes at, above or below the field (a stand-in; v5 has none)
//   equals  if: { equals: old } on the field's value
// A conflict is "true" when a write at or above the field committed in the window, "false" when only sibling writes did.
// The field guard must never pass a true conflict (a lost update).
// Planted bug (E58_MUTATE=noancestor): the field version is not moved by whole-row writes; it must then fail.
import { MUT, rng, inc } from './common.mjs'

export function runSeed(seed, { sib }, S) {
  const r = rng(seed * 7 + Math.round(sib * 100))
  const failed = new Set()
  const fail = (k) => { inc(S, 'FAIL:' + k); failed.add(k) }
  const keys = ['w0', 'w1', 'w2']
  const rows = new Map(keys.map((k) => [k, { stock: 5, price: 10, name: 'a' }]))
  let seq = 0
  const rowVer = new Map(keys.map((k) => [k, 0])), fieldVer = new Map(keys.map((k) => [k, 0]))
  const atOrAbove = new Map(keys.map((k) => [k, 0])) // the truth: the last seq of a write at or above stock
  const pending = []
  const commit = (k, kind, apply) => {
    seq++
    apply(rows.get(k))
    rowVer.set(k, seq)
    if (kind === 'at' || (kind === 'above' && MUT !== 'noancestor')) fieldVer.set(k, seq)
    if (kind === 'at' || kind === 'above') atOrAbove.set(k, seq)
  }
  for (let step = 0; step < 400; step++) {
    // guarded writes whose time has come
    for (let i = pending.length - 1; i >= 0; i--) {
      const g = pending[i]
      if (--g.wait > 0) continue
      pending.splice(i, 1)
      inc(S, 'guarded')
      const k = g.k, row = rows.get(k)
      const truthConflict = atOrAbove.get(k) > g.at
      const changed = row.stock !== g.s0
      if (truthConflict) inc(S, 'conflict:true'); else if (rowVer.get(k) > g.rv) inc(S, 'conflict:false-sibling-only')
      const passRow = rowVer.get(k) === g.rv, passField = fieldVer.get(k) === g.fv, passEq = row.stock === g.s0
      if (!passRow) { inc(S, 'row:refused'); if (!truthConflict) inc(S, 'row:refused-sibling-only') }
      if (!passField) inc(S, 'field:refused')
      if (!passEq) inc(S, 'equals:refused')
      if (passField && truthConflict) fail('field:lost-update')
      if (passRow && truthConflict) fail('row:lost-update')
      if (passEq && truthConflict) inc(S, changed ? 'equals:passed-changed?' : 'equals:passed-aba')
      // the write itself goes through by the row guard (v5 as written)
      if (passRow) commit(k, 'at', (x) => { x.stock = g.s0 > 0 ? g.s0 - 1 : 0 })
    }
    // a new guarded writer, now and then
    if (r() < 0.3) { const k = r.pick(keys); pending.push({ k, at: seq, rv: rowVer.get(k), fv: fieldVer.get(k), s0: rows.get(k).stock, wait: 1 + r.int(6) }) }
    // another writer
    const k = r.pick(keys), x = r()
    if (x < sib) { inc(S, 'w:beside'); commit(k, 'beside', (o) => { if (r() < 0.5) o.price = 10 * r.int(10); else o.name = r.pick(['a', 'b']) }) }
    else { const y = r(); if (y < 0.6) { inc(S, 'w:at'); commit(k, 'at', (o) => { o.stock = r.int(6) }) } else if (y < 0.85) { inc(S, 'w:above-row'); commit(k, 'above', (o) => { o.stock = r.int(6); o.price = 10 * r.int(10) }) } else { inc(S, 'w:above-merge'); commit(k, 'above', (o) => { o.name = r.pick(['a', 'b']); if (r() < 0.5) o.stock = r.int(6) }) } }
  }
  return failed
}
