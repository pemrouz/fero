// E-55: the tables, from results/*.jsonl. Each timed number is shown as the range over the runs (min-max).
//   node summarize.mjs
import { readFileSync, existsSync } from 'node:fs'
const R = new URL('./results/', import.meta.url)
const lines = (f) => existsSync(new URL(f, R)) ? readFileSync(new URL(f, R), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((x) => x && x.exp === 'E-55') : []
const rng = (xs) => { xs = xs.filter((x) => typeof x === 'number'); if (!xs.length) return 'n/a'; const a = Math.min(...xs), b = Math.max(...xs); const f = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100); return a === b ? String(f(a)) : `${f(a)}-${f(b)}` }
const by = (xs, key) => { const m = new Map(); for (const x of xs) { const k = key(x); m.set(k, [...(m.get(k) ?? []), x]) } return m }
const table = (head, rows) => { console.log('| ' + head.join(' | ') + ' |'); console.log('|' + head.map(() => '---').join('|') + '|'); for (const r of rows) console.log('| ' + r.join(' | ') + ' |'); console.log() }
const failed = ['step', 'connect', 'gc', 'pushdown', 'net', 'depth2', 'asof', 'marks', 'natural', 'sims', 'mutants'].flatMap((f) => (existsSync(new URL(f + '.jsonl', R)) ? readFileSync(new URL(f + '.jsonl', R), 'utf8').split('\n').filter((l) => l.includes('"part":"failed"')) : []))
if (failed.length) { console.log('### Failed processes\n'); for (const f of failed) console.log('- ' + f.slice(0, 300)); console.log() }

const step = lines('step.jsonl')
console.log('### Claim 1: a step (ns)\n')
table(['rows', 'direct', 'kept verb', 'lens1', 'lens2', 'at2', 'data handle2', 'map', 'step (same key)', 'step (spread)', 'kept over direct', 'at over direct'],
  [...by(step.filter((x) => x.bench === 'step-read'), (x) => x.rows)].map(([n, xs]) => [n, rng(xs.map((x) => x.same.direct)), rng(xs.map((x) => x.same.kept)), rng(xs.map((x) => x.same.lens1)), rng(xs.map((x) => x.same.lens2)), rng(xs.map((x) => x.same.at2)), rng(xs.map((x) => x.same.handle2)), rng(xs.map((x) => x.same.map)), rng(xs.map((x) => x.derived.step_same)), rng(xs.map((x) => x.derived.step_spread)), rng(xs.map((x) => x.derived.kept_over_direct)), rng(xs.map((x) => x.derived.at_over_direct_same))]))
const sv = step.filter((x) => x.bench === 'step-variant')
if (sv.length) {
  console.log('### Claim 1 follow-up: four ways to build a step (ns per step: (two steps and the read − the direct read) / 2)\n')
  table(['rows', 'keys', 'proto', 'handler', 'shared', 'plain', 'direct read'],
    [...by(sv, (x) => x.rows)].flatMap(([n, xs]) => [['stepSame', 'same'], ['stepSpread', 'spread']].map(([k, raw]) => [n, raw, ...['proto', 'handler', 'shared', 'plain'].map((w) => rng(xs.map((x) => x[k][w]))), rng(xs.map((x) => x[raw].direct))])))
}
console.log('### Claim 2: bytes kept per distinct key (100,000 keys)\n')
table(['way', 'B per key'], [...by(step.filter((x) => x.bench === 'step-mem'), (x) => x.way)].map(([w, xs]) => [w, rng(xs.map((x) => x.bytesPerKey))]))
console.log('### Claim 3: a write (ns)\n')
table(['rows', 'f.set([k,n],v)', 'L[k].n.set(v)', 'kept.set(v)', 'f.at(k,n).set(v)', 'data handle today', 'steps over direct', 'kept over direct'],
  [...by(step.filter((x) => x.bench === 'step-write'), (x) => x.rows)].map(([n, xs]) => [n, ...['f.set([k,n],v)', 'L[k].n.set(v)', 'kept.set(v)', 'f.at(k,n).set(v)', 'data h.get(k).get(n).update(v)'].map((k) => rng(xs.map((x) => x.ns[k]))), rng(xs.map((x) => x.over_direct.steps)), rng(xs.map((x) => x.over_direct.kept))]))

const con = lines('connect.jsonl')
const setup = con.filter((x) => x.bench === 'setup-second')
if (setup.length) {
  console.log('### Claim 6: set-up (ns each, 10,000 of each)\n')
  table(['what', 'ns'], Object.keys(setup[0].ns).map((k) => [k, rng(setup.map((x) => x.ns[k]))]))
  const pics = con.filter((x) => x.bench === 'setup-first-picture').flatMap((x) => x.pictures)
  table(['rows in all', 'rows in the room', 'first picture ms'], [...by(pics, (p) => p.rows + '|' + p.roomRows)].map(([k, ps]) => [ps[0].rows, ps[0].roomRows, rng(ps.map((p) => p.ms))]))
}
const wp = con.filter((x) => x.bench === 'weak-probe')
if (wp.length) {
  console.log('### Claim 6 follow-up: a registration, B made in one job (ns each, the loop and clock subtracted)\n')
  const Bs = [1, 10, 100, 1000, 10000]
  const groups = [['a clean process', wp.filter((x) => !x.loadedRows)], ['100,000 rows held', wp.filter((x) => x.loadedRows > 0)]].filter(([, xs]) => xs.length)
  table(['process', 'runs', 'way', ...Bs.map((b) => 'B=' + b)], groups.flatMap(([g, xs]) => ['weakref', 'register', 'both', 'object'].map((w) => [g, xs.length, w, ...Bs.map((b) => rng(xs.map((x) => x.nsNet[w + ' B=' + b])))])))
}
const fp = con.filter((x) => x.bench === 'first-probe')
if (fp.length) {
  console.log('### Claim 6 follow-up: a first picture of a 100-row room, with and without a full collection right before (µs)\n')
  table(['what', 'runs', 'p50', 'p90'], Object.keys(fp[0].us).map((k) => [k, fp.length, rng(fp.map((x) => x.us[k].p50)), rng(fp.map((x) => x.us[k].p90))]))
}
const fan = con.filter((x) => x.bench === 'path-fan')
if (fan.length) {
  console.log('### Claim 8: K lenses on K rows (ns per write, 100,000 rows)\n')
  table(['K', 'lens (keyed index)', 'data path connect today'], Object.keys(fan[0].nsPerWrite).map((k) => [k, rng(fan.map((x) => x.nsPerWrite[k].lens)), rng(fan.map((x) => x.dataPathConnectToday[k]))]))
  console.log('ratio K=10,000 / K=0: ' + rng(fan.map((x) => x.ratio_10000_over_0)) + '; K=100,000 / K=0: ' + rng(fan.map((x) => x.ratio_100000_over_0)) + '\n')
}
const tap = con.filter((x) => x.bench === 'tap')
if (tap.length) {
  console.log('### Claim 10: tap((c) => …) (ns per write, 10,000 rows)\n')
  table(['derived', 'ns'], Object.keys(Object.assign({}, ...tap.map((x) => x.derived))).map((k) => [k, rng(tap.map((x) => x.derived[k]))]))
}
const weak = con.filter((x) => x.bench === 'weak')
if (weak.length) {
  console.log('### Claim 11: 10,000 weak links against 10,000 strong sinks (ns per commit)\n')
  // the sinks with work: only lines where each strong sink writes its own object (strongOwnTarget); run 1's first
  // harness had them all write one shared object, which favoured the strong side
  const rows = [['no work', weak.filter((x) => !x.sinkWork)], ['work, own target', weak.filter((x) => x.sinkWork && x.strongOwnTarget)], ['work, shared object (first harness)', weak.filter((x) => x.sinkWork && !x.strongOwnTarget)]].filter(([, xs]) => xs.length)
  table(['sinks', 'runs', 'strong ns/commit', 'weak ns/commit', 'ratio', 'per link delta ns', 'deref check ns'], rows.map(([n, xs]) => [n, xs.length, rng(xs.flatMap((x) => [x.ns.strong.nsPerCommit, x.ns.strong2.nsPerCommit])), rng(xs.flatMap((x) => [x.ns.weak.nsPerCommit, x.ns.weak2.nsPerCommit])), rng(xs.map((x) => x.ratio_weak_over_strong)), rng(xs.map((x) => x.perLinkDelta)), rng(xs.map((x) => x.derefCheckNs))]))
}
const gc = lines('gc.jsonl')
const forced = gc.filter((x) => x.bench === 'forced')
if (forced.length) {
  console.log('### Claim 12: forced collection\n')
  table(['commit before collection ms', 'calls then', 'commit after gc ms', 'calls after gc', 'ended by check', 'round 2 ended by finalizer'], [[rng(forced.map((x) => x.commitBeforeCollection.ms)), rng(forced.map((x) => x.commitBeforeCollection.calls)), rng(forced.map((x) => x.commitSameTurnAfterGc.ms)), rng(forced.map((x) => x.commitSameTurnAfterGc.calls)), rng(forced.map((x) => x.commitSameTurnAfterGc.endedByCheck)), rng(forced.map((x) => x.round2.endedByFinalizer))]])
}
const nat = lines('natural.jsonl')
if (nat.length) {
  console.log('### Claim 13: natural collection (links ended by 0.1/1/5/15/30 s, of 1,000)\n')
  table(['where', 'age', 'mode', 'by 0.1 s', 'by 1 s', 'by 5 s', 'by 15 s', 'by 30 s', 'p50 ms', 'p99 ms', 'how'],
    [...by(nat, (x) => (x.bench === 'browser' ? 'browser' : 'node') + '|' + (x.age ?? '-') + '|' + x.mode)].map(([k, xs]) => [...k.split('|'), ...[100, 1000, 5000, 15000, 30000].map((t) => rng(xs.map((x) => x.endedBy[t]))), rng(xs.map((x) => x.p50Ms)), rng(xs.map((x) => x.p99Ms)), JSON.stringify(xs[0].why)]))
}
const cap = gc.filter((x) => x.bench === 'capture')
if (cap.length) { console.log('### Claim 15: the capture trap\n'); console.log('```json\n' + JSON.stringify(cap[0], null, 1) + '\n```\n') }

const push = lines('pushdown.jsonl')
const pd = push.filter((x) => x.bench === 'pushdown')
if (pd.length) {
  console.log('### Claim 16: a view pushed to the server (push) against the room held and the view run here (local)\n')
  table(['room rows', 'shapes', 'mode', 'server ns/change', 'server ns/view', 'encodes/change', 'wire B/change', 'client ns/change', 'first picture B/shape', 'server heap B/shape', 'answers right'],
    [...by(pd, (x) => x.roomRows + '|' + x.shapes + '|' + x.mode)].map(([k, xs]) => [...k.split('|'), rng(xs.map((x) => x.perChange.serverNs)), rng(xs.map((x) => x.serverNsPerView)), rng(xs.map((x) => x.perChange.serverEncodes)), rng(xs.map((x) => x.perChange.wireBytes)), rng(xs.map((x) => x.perChange.clientNs)), rng(xs.map((x) => x.firstPictureBytesPerShape)), rng(xs.map((x) => x.serverHeapPerShapeB)), xs.every((x) => x.answersRight)]))
}
const vp = push.filter((x) => x.bench === 'view-probe')
if (vp.length) {
  console.log('### Claim 16 follow-up: one gt().za(10) view in data alone (ns per field write)\n')
  const hs = ['seeded+promote', 'seeded', 'written']
  table(['rows', ...hs.map((h) => h + ': no view'), ...hs.map((h) => h + ': the view adds')], [...by(vp, (x) => x.rows)].map(([n, xs]) => [n, ...hs.map((h) => rng(xs.map((x) => x.ns[h]))), ...hs.map((h) => rng(xs.map((x) => x.viewNsPerChange[h])))]))
}
const net = lines('net.jsonl')
const miss = net.filter((x) => x.bench === 'miss')
if (miss.length) { console.log('### Claim 20: 100,000 reads through `await lens`\n'); table(['server GETs', 'server SUBs', 'client selections', 'cache rows', 'heap delta B', 'µs per read'], [[rng(miss.map((x) => x.serverGets)), rng(miss.map((x) => x.serverSubs)), rng(miss.map((x) => x.clientSelections)), rng(miss.map((x) => x.cacheRows)), rng(miss.map((x) => x.heapDeltaB)), rng(miss.map((x) => x.usPerRead))]]) }
const d2 = lines('depth2.jsonl')
if (d2.length) {
  console.log('### Claim 19: depth 2 against flat (storeBytes: rows and structure)\n')
  const base = new Map(); for (const x of d2.filter((x) => x.way === 'flat')) base.set(x.rows + '|' + x.rowsPerPartition, [...(base.get(x.rows + '|' + x.rowsPerPartition) ?? []), x])
  table(['rows', 'rows/partition', 'way', 'fold ns/record', 'fold vs flat', 'B per partition over flat', '100-row... first picture ms', 'row write ns', 'key +B (JSON)'],
    [...by(d2, (x) => x.rows + '|' + x.rowsPerPartition + '|' + x.way)].map(([k, xs]) => { const [n, p, w] = k.split('|'); const b = base.get(n + '|' + p) ?? []; const bf = Math.min(...b.map((x) => x.foldNsPerRecord)); const bb = Math.min(...b.map((x) => x.storeBytes)); return [n, p, w, rng(xs.map((x) => x.foldNsPerRecord)), b.length ? rng(xs.map((x) => x.foldNsPerRecord / bf)) : 'n/a', b.length ? rng(xs.map((x) => (x.storeBytes - bb) / x.partitions)) : 'n/a', rng(xs.map((x) => x.firstPictureMs)), rng(xs.map((x) => x.rowWriteNs)), rng(xs.map((x) => x.keyExtraBytesJson))] }))
}
const asof = lines('asof.jsonl')
if (asof.length) {
  console.log('### Claim 23: asOf, fat nodes fed from data\'s prev (1,000,000 records)\n')
  table(['rows', 'mode', 'hot', 'ns/record', 'kept B/version', 'step ns', 'row at version ns', 'hot row versions', 'hot row ns', 'checks wrong'],
    [...by(asof, (x) => x.rows + '|' + x.mode + '|' + (x.hot ?? ''))].map(([k, xs]) => [...k.split('|'), rng(xs.map((x) => x.nsPerRecord)), rng(xs.map((x) => x.keptBytesPerVersion)), rng(xs.map((x) => x.stepNs)), rng(xs.map((x) => x.rowAtVersionNs)), rng(xs.map((x) => x.hotRowVersions)), rng(xs.map((x) => x.hotRowAtVersionNs)), xs[0].checks ? xs.map((x) => x.checks.wrong + '/' + x.checks.checked).join(' ') : '']))
}
const marks = lines('marks.jsonl')
if (marks.length) { console.log('### Claim 21: rate\n'); table(['awaited /s', 'not awaited /s', 'ratio'], [[rng(marks.map((x) => x.awaitedPerS)), rng(marks.map((x) => x.notAwaitedPerS)), rng(marks.map((x) => x.ratio))]]) }
console.log('### Seeded runs and counters\n')
for (const x of [...lines('sims.jsonl'), ...lines('mutants.jsonl')]) console.log('```json\n' + JSON.stringify(x) + '\n```')
console.log('\n### Types and imports\n')
for (const x of [...lines('types.jsonl'), ...lines('imports.jsonl')]) console.log('- ' + JSON.stringify(x).slice(0, 400))


// ── the review pass (2026-11-18): the prototype as changed for the skeptic's findings ──
const rt = lines('review-timing.jsonl'), rs = lines('review-sims.jsonl')
const rerun = existsSync(new URL('./review/rerun.jsonl', import.meta.url)) ? readFileSync(new URL('./review/rerun.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const medOf = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); if (!v.length) return NaN; return v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2 }
const f1 = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10)
const span = (xs, f = f1) => f(Math.min(...xs)) + ' to ' + f(Math.max(...xs))
const verdictRow = (what, bar, xs, f = f1) => { xs = xs.filter((x) => typeof x === 'number'); const m = medOf(xs); return [what, bar, xs.length, f(m), span(xs, f), xs.map(f).join(', '), m <= bar ? 'meets' : 'misses'] }
if (rt.length || rs.length) {
  console.log('## The review pass\n')
  console.log('### One verdict rule: the median of every run against the bar (first runs, the reviewer\'s rerun, the review pass)\n')
  const all = (bench, rows) => [...step, ...rerun, ...rt].filter((x) => x.bench === bench && x.rows === rows)
  const con2 = [...con, ...rerun, ...rt]
  const rows = []
  for (const n of [1000, 100000, 1000000]) rows.push(verdictRow(`claim 1: a step, keys spread, ${n} rows (ns)`, 150, all('step-read', n).map((x) => x.derived.step_spread)))
  for (const n of [1000, 100000, 1000000]) rows.push(verdictRow(`claim 1: a step, one key, ${n} rows (ns)`, 150, all('step-read', n).map((x) => x.derived.step_same)))
  for (const n of [1000, 100000, 1000000]) rows.push(verdictRow(`claim 1: a kept verb over direct, ${n} rows (ns)`, 200, all('step-read', n).map((x) => x.derived.kept_over_direct)))
  for (const n of [1000, 100000, 1000000]) rows.push(verdictRow(`claim 1: at() over direct, keys spread, ${n} rows (ns)`, 100, all('step-read', n).map((x) => x.derived.at_over_direct_spread)))
  for (const n of [1000, 100000, 1000000]) rows.push(verdictRow(`claim 1: at() over direct, one key, ${n} rows (ns)`, 100, all('step-read', n).map((x) => x.derived.at_over_direct_same)))
  for (const n of [10000, 100000, 1000000]) rows.push(verdictRow(`claim 3: steps over direct, ${n} rows (ns)`, 1000, all('step-write', n).map((x) => x.over_direct.steps)))
  for (const n of [10000, 100000, 1000000]) rows.push(verdictRow(`claim 3: kept over direct, ${n} rows (ns)`, 300, all('step-write', n).map((x) => x.over_direct.kept)))
  // claim 8: the first build (3 runs, the reviewer's rerun, and 4 runs of the A/B), the changed build (the review
  // pass's 3 runs and 4 runs of the A/B). The A/B (results/review-fan-ab.jsonl) alternated the two builds in one hold.
  const ab = lines('review-fan-ab.jsonl')
  const fanFirst = [...con, ...rerun, ...ab.filter((x) => x.build === 'first')].filter((x) => x.bench === 'path-fan')
  const fanChanged = [...rt, ...ab.filter((x) => x.build === 'changed')].filter((x) => x.bench === 'path-fan')
  const f2 = (v) => v.toFixed(2)
  rows.push(verdictRow('claim 8: K = 10,000 over K = 0 (ratio), every run', 1.3, [...fanFirst, ...fanChanged].map((x) => x.ratio_10000_over_0), f2))
  rows.push(verdictRow('claim 8: the first build only', 1.3, fanFirst.map((x) => x.ratio_10000_over_0), f2))
  rows.push(verdictRow('claim 8: the changed build only', 1.3, fanChanged.map((x) => x.ratio_10000_over_0), f2))
  table(['what', 'bar', 'runs', 'median', 'lowest to highest', 'every run', 'the median'], rows)
  for (const [name, xs] of [['the first build', fanFirst], ['the changed build', fanChanged]]) console.log('claim 8, ' + name + ', ns per write: K = 0: ' + span(xs.map((x) => x.nsPerWrite['0'].lens)) + ' (median ' + f1(medOf(xs.map((x) => x.nsPerWrite['0'].lens))) + '); K = 10,000: ' + span(xs.map((x) => x.nsPerWrite['10000'].lens)) + ' (median ' + f1(medOf(xs.map((x) => x.nsPerWrite['10000'].lens))) + ')\n')
  const t2 = rt.filter((x) => x.bench === 'tap-interleaved')
  if (t2.length) {
    console.log('### Claim 10, the ways interleaved round by round (ns per write; each cell: the median of 9 rounds; "runs" is the range of that median over the runs; "rounds" is the lowest and highest single round of any run)\n')
    table(['difference, inside one round', 'runs: median', 'each run', 'rounds: lowest to highest'], Object.keys(t2[0].derived).map((k) => [k, span(t2.map((x) => x.derived[k].med)), t2.map((x) => f1(x.derived[k].med)).join(', '), f1(Math.min(...t2.map((x) => x.derived[k].lo))) + ' to ' + f1(Math.max(...t2.map((x) => x.derived[k].hi)))]))
    table(['way', 'ns per write: median of 9 rounds, range over the runs'], Object.keys(t2[0].ns).map((k) => [k, span(t2.map((x) => x.ns[k].med))]))
  }
  const miss2 = rt.filter((x) => x.bench === 'miss')
  if (miss2.length) console.log('claim 20 again with lens.get(): ' + miss2.map((x) => `${x.serverGets} GETs, ${x.serverSubs} SUBs, ${x.clientSelections} selections, ${x.cacheRows} rows kept, ${x.getsBehindSeen} answers behind the position seen, ${x.usPerRead} µs a read`).join(' | ') + '\n')
  console.log('### The seeded runs on the changed prototype (raw lines)\n')
  for (const x of rs) console.log('```json\n' + JSON.stringify(x).slice(0, 3000) + '\n```')
}
