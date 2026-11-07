// E-05 part 6: how data's group view's cost per record grows with the size of its buckets.
//   node --expose-gc group-scale.mjs <rows>
// One source of n rows (filled through fero's seam), then ONE of: a group view by region (16 buckets) with a
// sink, the same group view with no sink, a counting view (data's length(fn): counts per bucket, no rows), or
// nothing. Then field updates in lane batches of 256 (records spread over all rows, so every batch touches
// every bucket). A warm-up batch runs first; the median of 3 rounds is reported.
import { S, key, laneFor, fill, gc, now, median, out } from './common.mjs'
const N = +process.argv[2]
for (const variant of ['none', 'counts', 'group', 'group+sink']) {
  const p = S.proxy({}); fill(p, N)
  let v = null, s = null
  if (variant.startsWith('group')) v = p.group((r) => r.region)
  if (variant === 'counts') v = p.length((r) => r.region)
  if (variant === 'group+sink') s = v.sink({ apply() {} })
  const lane = laneFor(p)
  const M = N >= 1e6 ? 512 : N >= 1e5 ? 1024 : 10240
  const xs = []
  for (let r = -1; r < 3; r++) {
    const recs = Array.from({ length: M }, (_, i) => ({ type: 0, key: [key(((r + 2) * M + i) * 7919 % N), 'n'], value: i }))
    const bs = []; for (let i = 0; i < M; i += 256) bs.push(recs.slice(i, i + 256))
    gc()
    const t0 = now()
    for (const b of bs) lane(b)
    if (r >= 0) xs.push(Number(now() - t0) / 1e3 / M)
  }
  out({ exp: 'E-05', part: 'group-scale', rows: N, bucket_rows: Math.round(N / 16), variant, us_per_record_b256: +median(xs).toFixed(2), min: +Math.min(...xs).toFixed(2), max: +Math.max(...xs).toFixed(2), records: M })
  s?.dispose(); void v
}
