// E-63: the tables, from results/runs.jsonl (a header line with the load average, then one result line per run)
// and results/spikes.jsonl (the side probes, the same way).
//   node summarize.mjs <runs.jsonl> [spikes.jsonl]        prints markdown
// Each cell: the median of the runs and, in brackets, the lowest and highest run. Runs are grouped by their hold
// (the header's `hold`; the first holds, before review, carry none and are grouped as "first"), so a range never
// mixes holds, and a comparison with the control pairs run i with the control's run i of the same hold.
import fs from 'node:fs'

const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const runs = [], failed = [], gcRuns = [] // runs with the GC log on are summarized apart
for (let i = 0; i < lines.length; i++) {
  const h = lines[i]
  if (!('loadavg' in h)) continue
  const r = lines[i + 1]
  if (!r || r.failed || r.exp !== 'E-63') { failed.push(`run ${h.run}: ${h.cell}`); continue }
  r._run = h.run; r._hold = h.hold || 'first'; r._load = +h.loadavg.split(' ')[0]; (r.gcstats ? gcRuns : runs).push(r); i++
}
const RATE0 = 50000
const rateOf = (r) => r.rate ?? r.client.rate ?? RATE0
const label = (r) => (r.leader_flags?.length ? 'M2 (A, ' + r.leader_flags.join(' ').replace('--max-semi-space-size=', 'semi-space ') + ' MB)' : r.form === 'M3' ? `M3 (${r.watch_ms ?? 500} ms)` : r.form) +
  (rateOf(r) !== RATE0 ? ` at ${(rateOf(r) / 1000).toLocaleString('en-US')},000/s` : '')
const BASE = ['none', 'A', 'M2 (A, semi-space 64 MB)', 'M2 (A, semi-space 2 MB)', 'M1', 'M3 (500 ms)', 'M3 (200 ms)', 'B', 'Bs', 'B2', 'B+rule', 'B+budget', 'B2+rule', 'B2+budget']
const rank = (l) => { const m = l.match(/^(.*) at ([\d,]+)\/s$/); const b = m ? m[1] : l; return (m ? 100 : 0) + (BASE.indexOf(b) < 0 ? 99 : BASE.indexOf(b)) }
const HOLD_ORDER = ['first', 'review-a', 'review-b']
const holdName = { first: 'the first holds (before review)', 'review-a': 'review hold a', 'review-b': 'review hold b' }
const groups = new Map() // "rows shape|hold" → label → runs
for (const r of runs) { const k = `${r.rows} ${r.shape}|${r._hold}`; if (!groups.has(k)) groups.set(k, new Map()); const g = groups.get(k); const l = label(r); if (!g.has(l)) g.set(l, []); g.get(l).push(r) }

const med = (xs) => { const s = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }
const fmt = (x, d) => (x === null || x === undefined ? 'n/a' : x === Infinity ? 'never' : Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))
const cell = (rs, f, d = 1) => {
  const xs = rs.map(f).map((x) => (x === null || x === undefined ? null : x))
  const ok = xs.filter((x) => x !== null)
  if (!ok.length) return 'n/a'
  const lo = Math.min(...ok), hi = Math.max(...ok), m = med(ok)
  const miss = xs.length - ok.length
  return (lo === hi ? fmt(m, d) : `${fmt(m, d)} (${fmt(lo, d)}-${fmt(hi, d)})`) + (miss ? ` [${miss} none]` : '')
}
const byRun = (rs, f, d = 1) => [...rs].sort((a, b) => a._run - b._run).map((r) => fmt(f(r), d)).join(', ')
const pct = (a, b) => (b ? (100 * a) / b : null)
const notLeader = (r) => r.followers.filter((f) => !f.events_ms_after_s0 || f.events_ms_after_s0.became_leader === null)
const sortedGroups = [...groups.entries()].sort((a, b) => { const [ra, ha] = a[0].split('|'), [rb, hb] = b[0].split('|'); return HOLD_ORDER.indexOf(ha) - HOLD_ORDER.indexOf(hb) || Number(rb.split(' ')[0]) - Number(ra.split(' ')[0]) })

const out = []
const p = (s = '') => out.push(s)
p('<!-- written by summarize.mjs from ' + file.split('/').pop() + ' -->')
for (const [g, cellsMap] of sortedGroups) {
  const [rs0, hold] = g.split('|'), [rows, shape] = rs0.split(' ')
  const cells = [...cellsMap.entries()].sort((a, b) => rank(a[0]) - rank(b[0]))
  p(`## ${Number(rows).toLocaleString('en-US')} ${shape} rows, ${holdName[hold] ?? hold}`)
  p()
  p('### Steady load (P-01): write latency at the client, send to answer, ms')
  p()
  p('Writes sent in the steady window (3 s after the start until 200 ms before the stall), at 50,000 writes a second unless the form says otherwise. ELD = event-loop delay, p99, ms, in the same window. Busy: the share of the steady window the thread was running (event-loop utilization; recorded from review on). Cores: the process\'s CPU, all threads, over the steady window (the leader; server 2, a follower throughout).')
  p()
  p('| form | runs | writes | p50 | p99 | p99 by run | p99.9 | max | plain writes p99 | judged writes p99 | ELD main p99 / max | ELD worker p99 / max | leader main busy | leader worker busy | leader cores | a follower\'s cores | load avg |')
  p('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [l, rs] of cells) {
    const S = (r) => r.client.steady
    p(`| ${l} | ${rs.length} | ${cell(rs, (r) => S(r).sent, 0)} | ${cell(rs, (r) => S(r).all.p50, 2)} | ${cell(rs, (r) => S(r).all.p99, 2)} | ${byRun(rs, (r) => S(r).all.p99, 1)} | ${cell(rs, (r) => S(r).all.p999, 1)} | ${cell(rs, (r) => S(r).all.max, 1)} | ${cell(rs, (r) => S(r).plain.p99, 2)} | ${cell(rs, (r) => S(r).judged.p99, 2)} | ${cell(rs, (r) => r.leader.eld_main_steady?.p99, 1)} / ${cell(rs, (r) => r.leader.eld_main_steady?.max, 0)} | ${cell(rs, (r) => r.leader.eld_worker_steady?.p99, 1)} / ${cell(rs, (r) => r.leader.eld_worker_steady?.max, 0)} | ${cell(rs, (r) => r.leader.elu_main_steady, 2)} | ${cell(rs, (r) => r.leader.elu_worker_steady, 2)} | ${cell(rs, (r) => r.leader.cores_steady, 2)} | ${cell(rs, (r) => r.followers[1].cores_steady, 2)} | ${cell(rs, (r) => r._load, 1)} |`)
  }
  p()
  if (hold !== 'first') { // the control in the same hold, run by run (finding 5 of the review)
    p('#### Above the control in the same hold, run by run')
    p()
    p('Each form\'s steady p99 minus the control\'s (`none`, at the same rate) in the same run of the same hold, ms.')
    p()
    p('| form | run 1 | run 2 | run 3 | range |')
    p('|---|---|---|---|---|')
    for (const [l, rs] of cells) {
      if (l.startsWith('none')) continue
      const ctl = cells.find(([cl]) => cl === (rateOf(rs[0]) === RATE0 ? 'none' : `none at ${(rateOf(rs[0]) / 1000).toLocaleString('en-US')},000/s`))
      if (!ctl) continue
      const d = [1, 2, 3].map((n) => { const a = rs.find((r) => r._run === n), c = ctl[1].find((r) => r._run === n); return a && c ? a.client.steady.all.p99 - c.client.steady.all.p99 : null })
      const ok = d.filter((x) => x !== null), sg = (x) => (x === null ? 'n/a' : (x >= 0 ? '+' : '') + fmt(x, 1))
      p(`| ${l} | ${d.map(sg).join(' | ')} | ${ok.length ? `${sg(Math.min(...ok))} to ${sg(Math.max(...ok))}` : 'n/a'} |`)
    }
    p()
  }
  p("### The stall (F-14): a 5 s stall of the leader's main thread; in the +rule and +budget forms, of one call of the user rule on the leader's worker")
  p()
  p('"Answered in the stall": writes sent during the stall and answered (committed, or refused) before it ended. "Waiting": sent and not yet answered. "Back to steady": from the end of the stall until every later 100 ms of sends has its p99 at or under max(5.73 ms, the steady p99.9), and every write answered.')
  p()
  p('| form | stall ms | writes sent in it | answered in the stall | of plain writes | of judged writes | longest with no answer, ms | p99 of those answered, ms | most waiting | ms until 512 waiting | heartbeat timer gap max, ms | followers: longest gap between leader messages, ms | last stall write answered, ms after the stall | back to steady, ms after the stall |')
  p('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [l, rs] of cells) {
    const T = (r) => r.client.stall
    p(`| ${l} | ${cell(rs, (r) => r.leader.stall_ms ?? (r.client.s1 - r.client.s0), 0)} | ${cell(rs, (r) => T(r).sent, 0)} | ${cell(rs, (r) => pct(T(r).answered_in_stall, T(r).sent), 1)} % | ${cell(rs, (r) => pct(T(r).plain_answered_in_stall, T(r).plain_sent), 1)} % | ${cell(rs, (r) => pct(T(r).judged_answered_in_stall, T(r).judged_sent), 1)} % | ${cell(rs, (r) => T(r).longest_no_answer_ms, 0)} | ${cell(rs, (r) => T(r).latency_answered_in_stall.p99, 1)} | ${cell(rs, (r) => T(r).max_pending, 0)} | ${cell(rs, (r) => T(r).ms_to_512_pending, 1)} | ${cell(rs, (r) => r.leader.hb_timer_gap.stall.max, 1)} | ${cell(rs, (r) => Math.max(...notLeader(r).map((f) => f.leader_msg_gap.stall.max ?? 0)), 1)} | ${cell(rs, (r) => r.client.after.last_stall_write_answered_after_ms, 0)} | ${cell(rs, (r) => r.client.after.back_to_steady_p99_ms ?? Infinity, 0)} |`)
  }
  p()
  const rules = cells.filter(([l]) => /\+(rule|budget)/.test(l))
  if (rules.length) {
    p("#### The user rule's stall on the leader's worker")
    p()
    // rule_block_ms is the time from the stall's start to the FIRST cut of the run. When a cut came before the
    // stall (a turn that ran over 10 ms with no stall), the stall had not started (s0 = 0) and the field holds a
    // clock reading, not a block: it is left out here, and the cuts outside the stall are counted instead. The
    // stall's own call is cut once (it loops for 5 s), so every other cut is a turn of ordinary writes.
    const block = (r) => { const b = r.leader.events.rule_block_ms; return /budget/.test(r.form) ? (b !== null && b <= r.leader.stall_ms ? b : null) : (b ?? r.leader.stall_ms) }
    const outside = (r) => (/budget/.test(r.form) ? r.leader.events.rule_timeouts - 1 : 0)
    p('| form | runs | the worker blocked in the stalled rule, ms | cuts by the budget, all | cuts outside the stall (turns of ordinary writes that ran over 10 ms) | writes refused `rule-timeout` |')
    p('|---|---|---|---|---|---|')
    for (const [l, rs] of rules) p(`| ${l} | ${rs.length} | ${cell(rs, block, 1)} | ${cell(rs, (r) => r.leader.events.rule_timeouts, 0)} | ${cell(rs, outside, 0)} | ${cell(rs, (r) => r.client.refused_by_status?.['6'] ?? 0, 0)} |`)
    p()
    p('"[n none]": in n runs the first cut came before the stall, so that run did not record the stalled call\'s block (the longest silence in the stall table bounds it).')
    p()
  }
  const m3s = cells.filter(([l]) => l.startsWith('M3'))
  if (m3s.length) {
    p('### M3: the watchdog\'s hand-over, ms after the stall began')
    p()
    p('| form | runs | watchdog fired | leadership handed over | new leader took it | client told `moved` | writes resent | hand-overs in the run (all servers) | late results dropped by the old leader | p99 of writes sent after the move, until the stall ended, ms |')
    p('|---|---|---|---|---|---|---|---|---|---|')
    const ev = (r) => r.leader.events_ms_after_s0, nl = (r) => r.followers.map((f) => f.events_ms_after_s0?.became_leader).find((x) => x !== null && x !== undefined)
    for (const [l, m3] of m3s) p(`| ${l} | ${m3.length} | ${cell(m3, (r) => ev(r).watch_trigger, 1)} | ${cell(m3, (r) => ev(r).handed_over, 1)} | ${cell(m3, nl, 1)} | ${cell(m3, (r) => r.client.moved_after_s0_ms, 1)} | ${cell(m3, (r) => r.client.resent, 0)} | ${cell(m3, (r) => [r.leader, ...r.followers].reduce((a, f) => a + (f.events?.handovers ?? 0), 0), 0)} | ${cell(m3, (r) => r.leader.events.dropped_results, 0)} | ${cell(m3, (r) => r.client.stall.latency_sent_after_moved?.p99, 2)} |`)
    p()
  }
  p('### Memory, MB (V8 heap after two forced collections; RSS of the process)')
  p()
  p('| form | leader main heap after load | leader worker heap after load | leader RSS after load | leader max RSS (the run\'s peak) | a follower\'s worker heap after load | B2 arena: written / dead at the end |')
  p('|---|---|---|---|---|---|---|')
  for (const [l, rs] of cells) {
    const M = (r) => r.leader.mem_after_load, cb = rs[0].leader.copy_bytes
    p(`| ${l} | ${cell(rs, (r) => M(r).main_heap_mb, 0)} | ${cell(rs, (r) => M(r).worker_heap_mb, 0)} | ${cell(rs, (r) => M(r).rss_mb, 0)} | ${cell(rs, (r) => r.leader.mem_end.max_rss_mb, 0)} | ${cell(rs, (r) => r.followers[0].mem_after_load?.worker_heap_mb, 0)} | ${cb ? `${cell(rs, (r) => r.leader.copy_bytes.written_mb, 0)} / ${cell(rs, (r) => r.leader.copy_bytes.dead_mb, 0)}` : ''} |`)
  }
  p()
}
// GC pauses, from the runs with the GC log on
if (gcRuns.length) {
  const gg = new Map()
  for (const r of gcRuns) { const k = `${r.rows} ${r.shape}|${label(r)}`; if (!gg.has(k)) gg.set(k, []); gg.get(k).push(r) }
  p('## GC pauses on the leader, from separate runs with the GC log on')
  p()
  p('Each GC pause V8 reports (perf_hooks `gc` entries: JavaScript stopped on that thread), in the steady window. "Major": mark-compact. The write p99 of these runs is beside them, run by run; the log itself is the only change. Each row set ran in one hold of its own.')
  p()
  p('| rows | form | runs | write p99 by run, ms | above the control, run by run, ms | ELD max by run, main / worker, ms | main: pauses, longest ms | main: major pauses, longest ms | main: pauses over 50 ms | worker: pauses, longest ms | worker: major pauses, longest ms | worker: pauses over 50 ms | B2 arena / dead / index, MB |')
  p('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  const keys = [...gg.keys()].sort((a, b) => Number(b.split(' ')[0]) - Number(a.split(' ')[0]) || a.split('|')[0].localeCompare(b.split('|')[0]) || rank(a.split('|')[1]) - rank(b.split('|')[1]))
  for (const k of keys) {
    const rs = gg.get(k), [rowsShape, l] = k.split('|'), G = (r, t) => r.leader[t].steady
    const ctl = gg.get(`${rowsShape}|none`) || [], sg = (x) => (x >= 0 ? '+' : '') + fmt(x, 1)
    const above = l === 'none' ? '' : [1, 2, 3].map((n) => { const a = rs.find((r) => r._run === n), c = ctl.find((r) => r._run === n); return a && c ? sg(a.client.steady.all.p99 - c.client.steady.all.p99) : 'n/a' }).join(', ')
    p(`| ${rowsShape} | ${l} | ${rs.length} | ${byRun(rs, (r) => r.client.steady.all.p99, 1)} | ${above} | ${byRun(rs, (r) => r.leader.eld_main_steady?.max, 0)} / ${byRun(rs, (r) => r.leader.eld_worker_steady?.max, 0)} | ${cell(rs, (r) => G(r, 'gc_main').n, 0)}, ${cell(rs, (r) => G(r, 'gc_main').max_ms, 1)} | ${cell(rs, (r) => G(r, 'gc_main').major_n, 0)}, ${cell(rs, (r) => G(r, 'gc_main').major_max_ms, 1)} | ${cell(rs, (r) => G(r, 'gc_main').over_50ms, 0)} | ${cell(rs, (r) => G(r, 'gc_worker').n, 0)}, ${cell(rs, (r) => G(r, 'gc_worker').max_ms, 1)} | ${cell(rs, (r) => G(r, 'gc_worker').major_n, 0)}, ${cell(rs, (r) => G(r, 'gc_worker').major_max_ms, 1)} | ${cell(rs, (r) => G(r, 'gc_worker').over_50ms, 0)} | ${rs[0].leader.copy_bytes ? `${cell(rs, (r) => r.leader.copy_bytes.arena_mb, 0)} / ${cell(rs, (r) => r.leader.copy_bytes.dead_mb, 0)} / ${cell(rs, (r) => r.leader.copy_bytes.index_mb, 0)}` : ''} |`)
  }
  p()
}
// the side probes: tick times of the row work alone (bench/spikes.mjs), and the rule budget (bench/budget.mjs)
const spikeFile = process.argv[3]
if (spikeFile && fs.existsSync(spikeFile)) {
  const sl = fs.readFileSync(spikeFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const probes = []
  for (let i = 0; i < sl.length; i++) { const h = sl[i]; if (!('loadavg' in h)) continue; const r = sl[i + 1]; if (!r || r.failed) { failed.push(`probe run ${h.run}: ${h.cell}`); continue } r._run = h.run; r._hold = h.hold || 'spikes'; probes.push(r); i++ }
  const NAME = { map: 'a Map of row objects (B without versions)', map2: 'a Map of rows and a Map of versions (B)', mapint: 'a Map of keys to numbers (no row objects)', lane: "data's lane (the fold)", 'lane+ver': "data's lane and a Map of versions (main in A)", compact: 'CompactRows (B2)', map2shard: 'B\'s two Maps, each cut into 256 (Bs)', upkeep: 'CompactRows (B2), then its upkeep as one block' }
  const ORDERV = ['map', 'map2', 'mapint', 'lane', 'lane+ver', 'compact', 'map2shard', 'upkeep']
  for (const hold of [...new Set(probes.map((r) => r._hold))]) {
    const sp = probes.filter((r) => r._hold === hold && r.part === 'spikes')
    if (sp.length) {
      const by = new Map(); for (const r of sp) { const k = `${r.variant}|${r.rows}`; if (!by.has(k)) by.set(k, []); by.get(k).push(r) }
      p(`## Side probe (${hold === 'spikes' ? 'the first probe hold' : 'the second probe hold, added after review'}): the row work alone, one thread`)
      p()
      p('50 writes of the mix a tick, 15,000 ticks run flat out, no I/O (bench/spikes.mjs). Tick time in ms; GC pauses in the same window. A Map rebuilds its table when its entries (live and removed) fill it; at 1,000,000 rows and 5,000 new keys a second of load that comes at tick 9,689 (48,576 keys short of 2^20), while 900,000 rows leave room for the whole probe.')
      p()
      p('| row store | rows | runs | tick p50 | tick p99 | tick p99.9 | longest tick | longest tick, by run | ticks over 10 ms | ticks over 50 ms | the longest tick came at (tick) | GC pauses, longest ms | major GCs, longest ms |')
      p('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
      const ks = [...by.keys()].sort((a, b) => ORDERV.indexOf(a.split('|')[0]) - ORDERV.indexOf(b.split('|')[0]) || Number(b.split('|')[1]) - Number(a.split('|')[1]))
      for (const k of ks) {
        const rs = by.get(k), [v, n] = k.split('|')
        p(`| ${NAME[v] ?? v} | ${Number(n).toLocaleString('en-US')} | ${rs.length} | ${cell(rs, (r) => r.tick_ms.p50, 3)} | ${cell(rs, (r) => r.tick_ms.p99, 2)} | ${cell(rs, (r) => r.tick_ms.p999, 1)} | ${cell(rs, (r) => r.tick_ms.max, 1)} | ${byRun(rs, (r) => r.tick_ms.max, 1)} | ${cell(rs, (r) => r.ticks_over_10ms, 0)} | ${cell(rs, (r) => r.ticks_over_50ms, 0)} | ${byRun(rs, (r) => r.longest_ticks[0][1], 0)} | ${cell(rs, (r) => r.gc.n, 0)}, ${cell(rs, (r) => r.gc.max_ms, 1)} | ${cell(rs, (r) => r.gc.major_n, 0)}, ${cell(rs, (r) => r.gc.major_max_ms, 1)} |`)
      }
      p()
      const up = sp.filter((r) => r.upkeep)
      if (up.length) {
        p("#### B2's upkeep, each step as one block (after the probe's 15,000 ticks)")
        p()
        p('| runs | index slots before | the index moved into twice the slots, ms | arena written / dead before, MB | the arena copied without its dead space, ms | arena written after, MB |')
        p('|---|---|---|---|---|---|')
        p(`| ${up.length} | ${cell(up, (r) => r.upkeep.before.index_mb / 12 * 2 ** 20, 0)} | ${cell(up, (r) => r.upkeep.rehash_ms, 1)} | ${cell(up, (r) => r.upkeep.before.written_mb, 0)} / ${cell(up, (r) => r.upkeep.before.dead_mb, 0)} | ${cell(up, (r) => r.upkeep.compact_ms, 1)} | ${cell(up, (r) => r.upkeep.after.written_mb, 0)} |`)
        p()
      }
    }
    const bu = probes.filter((r) => r._hold === hold && r.part === 'budget')
    if (bu.length) {
      p('## Side probe: what a time budget on a user rule costs a write (bench/budget.mjs)')
      p()
      p('A one-line rule, called five ways; µs a write, and the cores that costs at 50,000 writes a second. A turn is 50 writes (one 1 ms tick of the load). "Cut": a rule that never returns, under a 10 ms budget, until the call is stopped.')
      p()
      p('| how the rule is called | runs | µs a write | cores at 50,000 writes a second |')
      p('|---|---|---|---|')
      const W = { direct: 'a plain call, no guard', vm_each: 'one vm call a write, no timeout', vm_each_budget: 'one vm call a write, 10 ms timeout (a budget a write)', vm_turn: 'one vm call a turn, no timeout', vm_turn_budget: 'one vm call a turn, 10 ms timeout (a budget a turn)' }
      for (const [k, name] of Object.entries(W)) p(`| ${name} | ${bu.length} | ${cell(bu, (r) => r.us_per_write[k], 3)} | ${cell(bu, (r) => r.cores_at_50k[k], 3)} |`)
      p()
      p(`Cut: ${cell(bu, (r) => Math.max(...r.cut_ms), 1)} ms at most a call, over ${bu.length} runs of five calls.`)
      p()
    }
  }
}
// checks: every copy ends with the same rows; no fold refused a record; every write was answered
const bad = []
let nRuns = 0
for (const r of [...runs, ...gcRuns]) {
  nRuns++
  const ds = [r.leader.digest, ...r.followers.map((f) => f.digest)], cds = [r.leader.log.copy_digest, ...r.followers.map((f) => f.log?.copy_digest)].filter(Boolean)
  const unans = r.client.unanswered_at_end ?? (r.client.steady.unanswered + r.client.stall.unanswered_at_end + r.client.after.unanswered)
  const rej = r.leader.fold_rejects + r.followers.reduce((a, f) => a + f.fold_rejects, 0)
  if (new Set([...ds, ...cds]).size !== 1 || unans || rej) bad.push(`run ${r._run} ${label(r)} ${r.rows}: digests ${[...new Set([...ds, ...cds])].join(',')}, unanswered ${unans}, fold rejects ${rej}`)
}
p('### Checks')
p()
p(`${nRuns} runs. In ${nRuns - bad.length} of them all three servers' rows (and, in the B forms, every worker's copy) ended with the same digest, no fold refused a record, and every write was answered.` + (bad.length ? ' Not in: ' + bad.join('; ') + '.' : ''))
if (failed.length) p(`Failed processes: ${failed.join('; ')}.`)
console.log(out.join('\n'))
