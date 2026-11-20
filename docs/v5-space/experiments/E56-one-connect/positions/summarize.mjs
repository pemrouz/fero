// E-56 positions: print the tables from results/*.jsonl. Each timed cell is the median of the runs' own
// medians, with the lowest and highest run in brackets. Byte counts are exact and the same in every run (checked).
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const R = join(dirname(fileURLToPath(import.meta.url)), 'results')
const read = (f) => existsSync(join(R, f)) ? readFileSync(join(R, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const f = (x) => x >= 1e4 ? Math.round(x).toLocaleString('en-US') : x >= 100 ? Math.round(x).toString() : x.toFixed(1)
const cell = (a) => a.length ? `${f(med(a))} (${f(Math.min(...a))}-${f(Math.max(...a))})` : '-'
const P = (s) => process.stdout.write(s + '\n')
const loads = (rows) => { const l = rows.filter((r) => r.loadavg && r.cmd).map((r) => +r.loadavg.split(' ')[0]); return l.length ? `load average at the start of each process: median ${med(l).toFixed(2)}, range ${Math.min(...l).toFixed(2)}-${Math.max(...l).toFixed(2)}, n=${l.length}` : '' }
const failed = (rows) => rows.filter((r) => r.part === 'failed')

// ── hash ──────────────────────────────────────────────────────────────────
const hash = read('hash.jsonl'), H = hash.filter((r) => r.part === 'hash')
P('### Hashing one commit (ns per commit; per record in the next column)\n')
P('| way | 1 record of 100 B | 1 record of 1 KB | 256 records of 100 B | per record | 256 records of 1 KB | per record | runs |')
P('|---|---|---|---|---|---|---|---|')
for (const way of [...new Set(H.map((r) => r.way))]) {
  const g = (recs, b, k = 'ns_commit') => H.filter((r) => r.way === way && r.recs === recs && r.rec_bytes === b).map((r) => r[k])
  P(`| ${way} | ${cell(g(1, 100))} | ${cell(g(1, 1000))} | ${cell(g(256, 100))} | ${cell(g(256, 100, 'ns_record'))} | ${cell(g(256, 1000))} | ${cell(g(256, 1000, 'ns_record'))} | ${g(1, 100).length} |`)
}
P('\n' + loads(hash) + (failed(hash).length ? `; FAILED: ${failed(hash).length}` : '') + '\n')

// ── tree ──────────────────────────────────────────────────────────────────
const tree = read('tree.jsonl'), T = tree.filter((r) => r.part === 'tree')
P('### Keeping a hash structure over one partition, per write (ns), and its memory (B a row)\n')
P('"extra" is the way minus `base` in the same run and size (each run\'s own pair), then the median and range over runs. "B a row (heap)" is heap plus array buffers after the structure is built, minus before, per row (the median over runs): it includes the per-row Maps, and is noisy at 1,000 rows. "tree B a row" is the tree\'s own typed arrays, exact. "inner µs" builds every inner node from the leaves (median of 5 in each run; the median and range over runs): what a peer\'s question costs when nothing above the leaves is kept. check: the kept structure equals one rebuilt from scratch after the writes.\n')
P('| rows | way | depth | ns a write | extra ns | B a row (heap) | tree B a row | inner µs | build ms | check | runs |')
P('|---|---|---|---|---|---|---|---|---|---|---|')
for (const n of [...new Set(T.map((r) => r.rows))].sort((a, b) => a - b)) {
  for (const way of ['base', 'ver', 'rowhash', 'sum', 'sumkept', 'mkver', 'mkverb', 'mkleaf', 'mkrow', 'mksha']) {
    const rs = T.filter((r) => r.rows === n && r.way === way)
    if (!rs.length) continue
    const extra = rs.map((r) => { const b = T.find((x) => x.rows === n && x.way === 'base' && x.run === r.run); return b ? r.ns_write - b.ns_write : NaN }).filter((x) => !Number.isNaN(x))
    const checks = [...new Set(rs.map((r) => r.check))].join(',')
    const tb = rs[0].tree_b_row == null ? '-' : f(rs[0].tree_b_row)
    const inner = rs[0].inner_ms == null ? '-' : cell(rs.map((r) => r.inner_ms * 1000))
    P(`| ${n.toLocaleString('en-US')} | ${way} | ${rs[0].depth} | ${cell(rs.map((r) => r.ns_write))} | ${way === 'base' ? '-' : cell(extra)} | ${f(med(rs.map((r) => r.bytes_row)))} | ${tb} | ${inner} | ${f(med(rs.map((r) => r.build_ms)))} | ${checks} | ${rs.length} |`)
  }
}
P('\n' + loads(tree) + (failed(tree).length ? `; FAILED: ${failed(tree).length}` : '') + '\n')

// ── resume ────────────────────────────────────────────────────────────────
for (const [file, title, timed] of [['resume.jsonl', '100 B rows', true], ['resume-1k.jsonl', '1 KB rows (bytes only)', false]]) {
  // one line per run and case: an earlier run.sh ran k = n / 10 again at 1,000 rows, where it equals k = 100
  const res = read(file), seenCase = new Set()
  const X = res.filter((r) => r.part === 'resume').filter((r) => { const id = `${r.run}/${r.rows}/${r.k}/${r.way}`; if (seenCase.has(id)) return false; seenCase.add(id); return true })
  if (!X.length) continue
  P(`### Resume after compaction, ${title}: bytes up and down, round trips${timed ? ', CPU' : ''}\n`)
  P('Bytes are exact under the stated encoding. (b) with 32 B hashes is in the last column. k rows changed, of which floor(k/10) removed.\n')
  P(`| rows | k | way | trips | bytes up | bytes down | total | vs (a) |${timed ? ' CPU µs |' : ''} (b) with 32 B hashes: total | check |`)
  P(`|---|---|---|---|---|---|---|---|${timed ? '---|' : ''}---|---|`)
  const keyOf = (r) => `${r.rows}/${r.k}/${r.way}`
  const groups = new Map()
  for (const r of X) { if (!groups.has(keyOf(r))) groups.set(keyOf(r), []); groups.get(keyOf(r)).push(r) }
  for (const [, rs] of [...groups].sort((a, b) => a[1][0].rows - b[1][0].rows || a[1][0].k - b[1][0].k || (a[1][0].way < b[1][0].way ? -1 : 1))) {
    const r = rs[0]
    const same = rs.every((x) => x.up === r.up && x.down === r.down && x.trips === r.trips)
    const full = X.find((x) => x.rows === r.rows && x.k === r.k && x.way === 'a-full')
    const tot = r.up + r.down
    const sha = r.way === 'b-walk' ? (r.up_sha + r.down_sha).toLocaleString('en-US') : '-'
    P(`| ${r.rows.toLocaleString('en-US')} | ${r.k.toLocaleString('en-US')} | ${r.way} | ${r.trips} | ${r.up.toLocaleString('en-US')} | ${r.down.toLocaleString('en-US')} | ${tot.toLocaleString('en-US')} | ${full ? (tot / (full.up + full.down)).toFixed(4) : '-'} |${timed ? ' ' + cell(rs.map((x) => x.cpu_us)) + ' |' : ''} ${sha} | ${[...new Set(rs.map((x) => x.check))].join(',')}${same ? '' : ' BYTES DIFFER'} |`)
  }
  const walks = X.filter((r) => r.way === 'b-walk')
  P('\nThe walk, per case: nodes that differed at each level (level 1 first), and the bytes a row both trees and their leaf lists take on one side:\n')
  P('| rows | k | differing per level | tree B a row (one side) |')
  P('|---|---|---|---|')
  const seen = new Set()
  for (const r of walks) { const k = r.rows + '/' + r.k; if (seen.has(k)) continue; seen.add(k); P(`| ${r.rows.toLocaleString('en-US')} | ${r.k.toLocaleString('en-US')} | ${r.differing_per_level} | ${r.tree_bytes_row} |`) }
  P('\n' + loads(res) + (failed(res).length ? `; FAILED: ${failed(res).length}` : '') + '\n')
}

// ── text forms ────────────────────────────────────────────────────────────
const tf = read('textform.jsonl').filter((r) => r.part === 'textform')
if (tf.length) {
  const t = tf[0]
  P('### What a version and a cursor look like as text\n')
  P(`Order checks: ${t.pairs.toLocaleString('en-US')} seeded pairs; string \`<\` disagreed with the number's \`<\` in ${t.wrong_fixed} (fixed form) and ${t.wrong_prefixed} (prefixed form); round trips wrong: ${t.round_trip_wrong}. Split: ${63 - t.seq_bits} bits of epoch above ${t.seq_bits} of sequence (a guess).\n`)
  P('| epoch | sequence | toNumber | fixed (13 chars) | prefixed |')
  P('|---|---|---|---|---|')
  for (const v of t.versions) P(`| ${v.epoch} | ${v.seq.toLocaleString('en-US')} | ${v.number} | \`${v.fixed}\` | \`${v.prefixed}\` |`)
  P('\nA one-partition cursor in E-19\'s layout (16 B resource id, incarnation, count, slot, epoch, sequence), as base64url:\n')
  P('| slot | epoch | sequence | bytes | chars | text |')
  P('|---|---|---|---|---|---|')
  for (const c of t.cursor_one_partition) P(`| ${c.slot} | ${c.epoch} | ${c.seq.toLocaleString('en-US')} | ${c.bytes} | ${c.chars} | \`${c.text}\` |`)
  P('\nWhole-resource cursors as base64url: ' + t.cursor_whole.map((w) => `${w.bytes.toLocaleString('en-US')} B → ${w.base64url_chars.toLocaleString('en-US')} chars`).join('; ') + ' (bytes: E-19 for 1,024 slots, 1,045 to 3,229; API.md section 7 for 4,096 slots, 4 to 13 KB, reasoned).\n')
}
