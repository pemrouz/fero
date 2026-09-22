import assert from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { fero } from '../../api/index.ts'
import { until } from '../lib.ts'

// every capture line the process printed, as numbers: [n, journal events, rows]
const lines = () => [...live.out.matchAll(/^capture (\d+) — journal (\d+) — (\d+) rows$/gm)].map((m) => m.slice(1).map(Number))

// start clean: the file on disk is what this run writes
rmSync('live.capture.json', { force: true })
const live = fero.spawn('live.ts')
assert.ok(await until(() => lines().length >= 3 && lines().at(-1)![2] === 6, 20_000), 'three captures, and six rows on node 0: four of them were written by the other two (is this example open in another terminal?)')
assert.ok(lines()[2][1] > lines()[0][1], 'the journal count grows: the file follows a running cluster')

// ctrl-c is the clean stop, and the last line printed describes the last file written
assert.equal(await live.stop(), 0, 'stopped cleanly on Ctrl-C')
const [n, journal, rows] = lines().pop()!
const cap = JSON.parse(readFileSync('live.capture.json', 'utf8'))
assert.equal(cap.kind, 'live', 'the file says live: that is what makes the viewer poll it')
assert.equal(cap.nodes.length, 3, 'three nodes in it')
assert.ok(cap.nodes.every((x: any) => x.epoch > 0 && x.journal.length > 0 && 'stateHash' in x), 'each in a view, with its journal and its state hash')
assert.equal(cap.nodes.reduce((s: number, x: any) => s + x.journal.length, 0), journal, `capture ${n}: the file holds the journal rows the line counted`)
assert.equal(cap.nodes[0].state.length, rows, 'and the rows')

rmSync('live.capture.json', { force: true })
console.log('ok 23-live')
