// E-57 group A: the oracle. Pure queries over plain rows (a Map key -> row), written without data, so a fault in
// data or in the served-view machinery cannot hide in the oracle. Every served view's value is compared, after
// every frame a client applies, with the query of the method version named in that frame, run from scratch on the
// truth rows at the frame's position.

// the exact sum, independent of the prototype's Shewchuk partials: every value in this harness is a double with an
// ulp of at least 2^-56 (values k/10 with |k| <= 1000, and small integers), so x * 2^60 is an exact integer; sum as
// BigInt, then Number() rounds once to nearest-even, and the division by 2^60 is exact
const SCALE = 2 ** 60
export function exactSum(vals) {
  let n = 0n
  for (const x of vals) {
    const y = x * SCALE
    if (!Number.isInteger(y)) throw new Error('oracle: value outside the exact domain: ' + x)
    n += BigInt(y)
  }
  return Number(n) / SCALE
}

// the total order of C1: a number field descending, ties by row key (the row carries its key as `id`)
export function cmpDescPure(f) {
  return (a, b) => {
    const x = a[f], y = b[f]
    if (x !== y) return x > y ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
}

export function cmpAscPure(f) {
  return (a, b) => {
    const x = a[f], y = b[f]
    if (x !== y) return x < y ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
}

// the methods' queries, by method and version. Each returns { kind, keys?, rows?, map?, value? }
export function query(method, ver, arg, rows) {
  const all = [...rows.values()]
  switch (method) {
    case 'best': {
      const f = ver === 1 ? 'points' : 'pts'
      const n = Math.min(arg, 100)
      const s = all.sort(cmpDescPure(f)).slice(0, n)
      return { kind: 'rows', keys: s.map((r) => r.id), rows: s }
    }
    case 'after': {
      const c = cmpDescPure('points'), cur = { points: arg[0], id: arg[1] }
      const s = all.filter((r) => c(r, cur) > 0).sort(c).slice(0, 20)
      return { kind: 'rows', keys: s.map((r) => r.id), rows: s }
    }
    case 'byTeam': {
      const f = ver === 1 ? 'pts' : 'points'
      const g = new Map()
      for (const r of all) { let a = g.get(r.team); if (!a) g.set(r.team, (a = [])); a.push(r[f]) }
      return { kind: 'buckets', map: new Map([...g].map(([k, vs]) => [k, exactSum(vs)])) }
    }
    case 'spread': { // by('pts').length(): one bucket per distinct pts value (it grows; used for views.rows)
      const g = new Map()
      for (const r of all) g.set(String(r.pts), (g.get(String(r.pts)) ?? 0) + 1)
      return { kind: 'buckets', map: g }
    }
    case 'total': return { kind: 'scalar', value: exactSum(all.map((r) => r.pts)) }
    case 'mine': return { kind: 'scalar', value: all.filter((r) => r.name === arg).length }
    case 'band': return { kind: 'scalar', value: all.filter((r) => r.points >= arg.lo && r.points <= arg.hi).length }
    case 'recent': { // XA-8: impure on purpose; the "query" is the view with the threshold the client first saw
      const s = all.filter((r) => r.at > arg.threshold).sort(cmpDescPure('at')).slice(0, 10)
      return { kind: 'rows', keys: s.map((r) => r.id), rows: s }
    }
    default: throw new Error('oracle: no query for ' + method)
  }
}

// class B / A7: a plain chain of operators over one partition's rows. ops: [['gt', f, v] | ['lt', f, v] |
// ['between', f, lo, hi] | ['az', f, n?] | ['za', f, n?] | ['sum', f] | ['length'] | ['max', f] | ['min', f]]
export function chainQuery(ops, rows) {
  let cur = { kind: 'rows', rows: [...rows.values()], ordered: false }
  for (const [op, ...a] of ops) {
    const rs = cur.rows
    switch (op) {
      case 'gt': cur = { ...cur, rows: rs.filter((r) => r[a[0]] > a[1]) }; break
      case 'lt': cur = { ...cur, rows: rs.filter((r) => r[a[0]] < a[1]) }; break
      case 'between': cur = { ...cur, rows: rs.filter((r) => r[a[0]] >= a[1] && r[a[0]] <= a[2]) }; break
      case 'az': case 'za': {
        const c = op === 'za' ? cmpDescPure(a[0]) : cmpAscPure(a[0])
        const s = [...rs].sort(c)
        cur = { kind: 'rows', rows: a[1] === undefined ? s : s.slice(0, a[1]), ordered: true }
        break
      }
      case 'sum': return { kind: 'scalar', value: exactSum(rs.map((r) => r[a[0]])) }
      case 'length': return { kind: 'scalar', value: rs.length }
      case 'max': return { kind: 'scalar', value: rs.length ? Math.max(...rs.map((r) => r[a[0]])) : undefined }
      case 'min': return { kind: 'scalar', value: rs.length ? Math.min(...rs.map((r) => r[a[0]])) : undefined }
      default: throw new Error('oracle: no op ' + op)
    }
  }
  return cur.ordered ? { kind: 'rows', keys: cur.rows.map((r) => r.id), rows: cur.rows } : { kind: 'set', keys: cur.rows.map((r) => r.id).sort(), rows: cur.rows }
}

const J = (x) => JSON.stringify(x)
// compare a client's shown value with an expected one. Returns null when equal, else a short reason.
export function compare(exp, shown) {
  if (exp.kind === 'rows') {
    if (shown.kind !== 'rows') return 'kind'
    if (J(exp.keys) !== J(shown.order)) return 'order'
    for (const r of exp.rows) if (J(r) !== J(shown.rows.get(r.id))) return 'row'
    if (shown.rows.size !== exp.keys.length) return 'size'
    return null
  }
  if (exp.kind === 'set') {
    const ks = [...shown.rows.keys()].sort()
    if (J(ks) !== J(exp.keys)) return 'keys'
    for (const r of exp.rows) if (J(r) !== J(shown.rows.get(r.id))) return 'row'
    return null
  }
  if (exp.kind === 'buckets') {
    if (shown.kind !== 'buckets') return 'kind'
    if (exp.map.size !== shown.map.size) return 'buckets'
    for (const [k, v] of exp.map) if (!Object.is(v, shown.map.get(k))) return 'bucket ' + k
    return null
  }
  if (shown.kind !== 'scalar') return 'kind'
  return Object.is(exp.value, shown.value) ? null : 'value'
}
