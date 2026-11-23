// E-65 X4: a KLL sketch (Karnin, Lang and Liberty 2016), after Liberty's reference code: levels of buffers,
// a full buffer is sorted and every other item is promoted with double weight. Rank error about 1.7 / k of the
// count, mergeable, insert only: an item once compacted cannot be taken out.
export class KLL {
  constructor(k = 200, r = Math.random, c = 2 / 3) { this.k = k; this.c = c; this.r = r; this.lv = []; this.size = 0; this.n = 0; this.grow() }
  grow() { this.lv.push([]); this.max = 0; for (let h = 0; h < this.lv.length; h++) this.max += this.cap(h) }
  cap(h) { return Math.ceil(Math.pow(this.c, this.lv.length - h - 1) * this.k) + 1 }
  add(x) { this.lv[0].push(x); this.size++; this.n++; if (this.size >= this.max) this.compress() }
  compress() {
    for (let h = 0; h < this.lv.length; h++) {
      if (this.lv[h].length >= this.cap(h)) {
        if (h + 1 >= this.lv.length) this.grow()
        const a = this.lv[h].sort((x, y) => x - y), keep = a.length & 1 ? [a.pop()] : []
        const off = this.r() < 0.5 ? 0 : 1
        for (let i = off; i < a.length; i += 2) this.lv[h + 1].push(a[i])
        this.lv[h] = keep
        this.size = 0; for (const l of this.lv) this.size += l.length
        if (this.size < this.max) break
      }
    }
  }
  merge(o) {
    while (this.lv.length < o.lv.length) this.grow()
    for (let h = 0; h < o.lv.length; h++) for (const x of o.lv[h]) this.lv[h].push(x)
    this.n += o.n; this.size = 0; for (const l of this.lv) this.size += l.length
    while (this.size >= this.max) this.compress()
  }
  rank(x) { let r = 0; for (let h = 0; h < this.lv.length; h++) for (const y of this.lv[h]) if (y <= x) r += 2 ** h; return r }
  weighted() { const out = []; for (let h = 0; h < this.lv.length; h++) for (const y of this.lv[h]) out.push([y, 2 ** h]); return out.sort((a, b) => a[0] - b[0]) }
  // the value of rank r (0-based)
  atRank(r) { let acc = 0; const w = this.weighted(); for (const [y, x] of w) { acc += x; if (r < acc) return y } return w.length ? w[w.length - 1][0] : undefined }
}

// removes by a second sketch of removed values: rank = inserted rank - removed rank. Its error is about
// 1.7 / k of (inserts + removes), not of the live count, so it grows with churn.
export class TurnstileKLL {
  constructor(k, r) { this.ins = new KLL(k, r); this.del = new KLL(k, r) }
  add(x) { this.ins.add(x) }
  remove(x) { this.del.add(x) }
  get n() { return this.ins.n - this.del.n }
  rank(x) { return this.ins.rank(x) - this.del.rank(x) }
  atRank(r) {
    const c = this.ins.weighted().map((e) => e[0])
    let lo = 0, hi = c.length - 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.rank(c[m]) > r) hi = m; else lo = m + 1 }
    return c[lo]
  }
}
