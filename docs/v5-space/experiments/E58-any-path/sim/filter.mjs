// E-58 part 4: the record form of a filtered log. A changes() entry carries `e.value` only for a whole-row write
// (API.md 3.10); a field write and a remove carry none. How often does a filter that reads only the record misjudge,
// against a filter that sees the row?
// The source: 8 rows { stock, price, name }, 200 records a seed: whole-row writes (adds and replaces), field writes to
// stock, price and name, a field remove of stock, row removes. The row after each record comes from data's real fold
// (a SourceNode), cross-checked against a plain model. Two filters: F1 `stock > 0`; F2 `stock > 0 && price < 50`.
// Three consumers, each judging "does this record leave its row in the filter?":
//   docs  `if (e.value && filter(e.value))`, the shape P-16, P-17 and derive's record form use today
//   key   keeps, per row key, only the fields its filter reads, from the records it sees (a partial fold)
//   row   the record form with rows (TRANSFORMS 3.4, later): the row after the record, from the fold
// It also keeps the set of rows in the filter, as a consumer that copies the filtered rows to a target would, and
// counts the rows that enter or leave the filter that the docs consumer never sees.
// Planted bug (E58_MUTATE=prevrow): the row consumer judges by the row BEFORE the record; it must then fail.
import { D, SourceNode } from '../../E55-lens-prototype/proto/lens.mjs'
import { MUT, rng, deepEq, inc } from './common.mjs'

const KEYS = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']
const F = {
  F1: { fields: ['stock'], test: (x) => x !== undefined && x !== null && typeof x === 'object' && x.stock > 0 },
  F2: { fields: ['stock', 'price'], test: (x) => x !== undefined && x !== null && typeof x === 'object' && x.stock > 0 && x.price < 50 },
}

export function runSeed(seed, S) {
  const r = rng(seed)
  const failed = new Set()
  const fail = (k) => { inc(S, 'FAIL:' + k); failed.add(k) }
  const rt = new D.Runtime()
  const src = new SourceNode(rt, {})
  const model = new Map()
  const rowv = () => ({ stock: r.int(4), price: 10 * r.int(10), name: r.pick(['a', 'b', 'c']) })
  // per filter, per consumer: the set of keys it believes are in the filter, and the key consumer's partial rows
  const sets = {}, part = {}
  for (const f of Object.keys(F)) { sets[f] = { docs: new Set(), key: new Set(), row: new Set(), truth: new Set() }; part[f] = new Map() }
  for (let i = 0; i < 200; i++) {
    const live = KEYS.filter((k) => model.has(k))
    const x = r()
    let rec, kind
    if (x < 0.25 || live.length === 0) { const k = r.pick(KEYS); rec = { t: 'set', key: [k], value: rowv() }; kind = model.has(k) ? 'row-replace' : 'row-add' }
    else if (x < 0.50) { rec = { t: 'set', key: [r.pick(live), 'stock'], value: r.int(4) }; kind = 'field-stock' }
    else if (x < 0.70) { rec = { t: 'set', key: [r.pick(live), 'price'], value: 10 * r.int(10) }; kind = 'field-price' }
    else if (x < 0.80) { rec = { t: 'set', key: [r.pick(live), 'name'], value: r.pick(['a', 'b', 'c']) }; kind = 'field-name' }
    else if (x < 0.85) { rec = { t: 'remove', key: [r.pick(live), 'stock'] }; kind = 'field-remove-stock' }
    else { rec = { t: 'remove', key: [r.pick(live)] }; kind = 'row-remove' }
    const k = rec.key[0]
    const before = model.get(k)
    // the fold: data, and the plain model beside it
    rt.batch(() => { if (rec.t === 'remove') src.remove(k, rec.key.length > 1 ? rec.key.slice(1) : undefined); else src.write(k, rec.key.slice(1), rec.value) })
    if (rec.t === 'remove') { if (rec.key.length === 1) model.delete(k); else { const n = { ...before }; delete n[rec.key[1]]; model.set(k, n) } }
    else model.set(k, rec.key.length === 1 ? rec.value : { ...before, [rec.key[1]]: rec.value })
    const after = src.get(k)
    if (!deepEq(after, model.get(k))) fail('fold')
    const e = { rec, value: rec.t === 'set' && rec.key.length === 1 ? rec.value : undefined }
    const fieldOnly = rec.key.length > 1
    inc(S, 'records'); inc(S, 'records:' + kind)
    for (const [fname, flt] of Object.entries(F)) {
      const truth = flt.test(after)
      // docs: the record alone
      const docs = e.value !== undefined && flt.test(e.value)
      // key: the filtered fields per key, from records
      const pm = part[fname]
      if (rec.t === 'remove' && rec.key.length === 1) pm.delete(k)
      else if (rec.key.length === 1) pm.set(k, Object.fromEntries(flt.fields.map((g) => [g, rec.value[g]])))
      else if (flt.fields.includes(rec.key[1])) { const cur = { ...(pm.get(k) ?? {}) }; if (rec.t === 'remove') delete cur[rec.key[1]]; else cur[rec.key[1]] = rec.value; pm.set(k, cur) }
      const keyv = pm.has(k) && flt.test(pm.get(k))
      // row: the row after the record (planted: before)
      const rowv2 = flt.test(MUT === 'prevrow' ? before : after)
      for (const [c, v] of [['docs', docs], ['key', keyv], ['row', rowv2]]) {
        if (v !== truth) { inc(S, `${fname}:${c}:misjudged`); inc(S, `${fname}:${c}:misjudged:${kind}`); if (fieldOnly) inc(S, `${fname}:${c}:misjudged-field-only`); if (c !== 'docs') fail(`${fname}:${c}`) }
      }
      if (fieldOnly) inc(S, `${fname}:field-only-records`)
      // the sets: what each consumer believes is in the filter
      const T = sets[fname]
      const was = T.truth.has(k)
      if (truth) T.truth.add(k); else T.truth.delete(k)
      if (truth !== was) { inc(S, `${fname}:truth:${truth ? 'enters' : 'leaves'}`); if (fieldOnly) inc(S, `${fname}:docs:never-sees-${truth ? 'entry' : 'exit'}`) }
      // docs: a whole-row record decides; a row remove takes it out; a field record says nothing
      if (e.value !== undefined) { if (docs) T.docs.add(k); else T.docs.delete(k) } else if (rec.t === 'remove' && rec.key.length === 1) T.docs.delete(k)
      if (keyv) T.key.add(k); else T.key.delete(k)
      if (rowv2) T.row.add(k); else T.row.delete(k)
      const same = (a, b) => a.size === b.size && [...a].every((y) => b.has(y))
      if (!same(T.docs, T.truth)) inc(S, `${fname}:docs:set-wrong-after-record`)
      if (!same(T.key, T.truth)) fail(`${fname}:key:set`)
      if (!same(T.row, T.truth)) fail(`${fname}:row:set`)
      if (i === 199 && !same(T.docs, T.truth)) inc(S, `${fname}:docs:seeds-final-set-wrong`)
      if (i === 199) inc(S, `${fname}:key:entries-kept`, [...pm.values()].reduce((n, o) => n + Object.keys(o).length, 0))
    }
  }
  return failed
}
