import assert from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { fero } from '../../api/index.ts'
import { verifyReplay } from '../../tools/debug/model.mjs'

// the file runs once and exits by itself: its lines, and the capture it wrote, are the lesson
rmSync('inside.capture.json', { force: true })
const r = fero.spawn('inside.ts')
assert.equal(await r.exited, 0, 'inside.ts ran to its end and exited 0 (is this example open in another terminal?)')
const line = (head: string) => r.out.trimEnd().split('\n').find((l) => l.startsWith(head)) ?? ''

// the handle answers on one line: a journal that dropped nothing, a log of the sixty writes, nothing in flight, nothing served
const h = /^journal \d+ \(0 dropped\) · log (\d+) · confirms \{ api: 0, kernel: 0 \} · served 0$/.exec(line('journal '))
assert.ok(h && Number(h[1]) >= 60, `the journal kept every event, the log holds the sixty writes, no probe in flight, nothing served (${line('journal ')})`)
const log = Number(h[1])

// compaction dropped entries, the log shrank, and the file says how to open the capture
const c = /^compacted (\d+) entries; log now (\d+)$/.exec(line('compacted '))
assert.ok(c && Number(c[1]) > 0 && Number(c[2]) < log, 'compaction dropped entries and the log is smaller')
assert.equal(line('open it:'), 'open it:  npm run debug -- examples/20-inside/inside.capture.json', 'and it names the capture to open')

// the capture: two nodes, each with a state hash and nothing dropped, and the viewer's replay reproduces each end state
const cap = JSON.parse(readFileSync('inside.capture.json', 'utf8'))
assert.equal(cap.nodes.length, 2, 'two nodes in the capture')
assert.ok(cap.nodes.every((n: { stateHash: unknown, dropped: number }) => typeof n.stateHash === 'number' && n.dropped === 0), 'each with a stateHash and an untruncated journal')
assert.ok(cap.nodes[0].stateHash === cap.nodes[1].stateHash, 'and the same state on both')
assert.ok(verifyReplay(cap).every((v: { ok: boolean }) => v.ok), 'every node replays to its captured state')
rmSync('inside.capture.json')
console.log('ok 20-inside')
