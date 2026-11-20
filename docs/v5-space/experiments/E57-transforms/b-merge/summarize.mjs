// E-57 group B: print the results as short lines (seeded runs) and ranges over runs (timed costs).
//   node summarize.mjs
import { readFileSync, existsSync } from 'node:fs'
const R = new URL('./results/', import.meta.url).pathname
const lines = (f) => (existsSync(R + f) ? readFileSync(R + f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
const rows = (f, ks) => { for (const o of lines(f)) if (o.exp === 'E-57') console.log(JSON.stringify(pick(o, ks))); else if (o.part === 'failed') console.log('FAILED', JSON.stringify(o)) }
console.log('## B1'); rows('b1.jsonl', ['groups', 'mutate', 'commits', 'checks', 'mismatches', 'moves', 'slotMoves', 'grows', 'shrinks', 'seconds'])
for (const o of lines('b1.jsonl')) if (o.consumers) console.log('  consumers', JSON.stringify(o.consumers.map((c) => pick(c, ['entries', 'failovers', 'redelivered', 'pictures', 'rebuilds', 'maxLag', 'opensBehind', 'opensBehindLag50', 'r1drops', 'r2diff', 'r2drop']))))
console.log('## B1 seeds'); rows('b1-seeds.jsonl', ['groups', 'mutate', 'seeds', 'seedsFailed', 'checks', 'mismatches', 'moves', 'slotMoves'])
console.log('## B2'); rows('b2.jsonl', ['planted', 'seeds', 'seedsFailed', 'checks', 'mismatches', 'pageWalksAtOneCut', 'dataWalks', 'cutWalks', 'cutWalkRowsStable', 'cutWalkRowsChanged', 'groupDeltas'])
console.log('## B3'); rows('b3.jsonl', ['config', 'planted', 'seeds', 'seedsFailed', 'idleChecks', 'unequal', 'seedsUnequal', 'staleAfterBump', 'staleBeforeBump', 'seedsStale', 'stepBacks', 'stepBacksAtChange', 'stepBacksElsewhere', 'seedsStepBack', 'v1AfterV2', 'seedsV1AfterV2', 'changes', 'minChanges', 'emptyDiffTakeovers', 'restartsAfterCut', 'writesPerSourceCommit', 'refused'])
console.log('## B4'); rows('b4.jsonl', ['planted', 'seeds', 'seedsFailed', 'checks', 'unequal', 'linkChecks', 'linkBad', 'endBad', 'trips', 'closedAfterLinger', 'pictures', 'records', 'undefinedSeen', 'nullSeen'])
console.log('## B6'); rows('b6.jsonl', ['planted', 'seeds', 'seedsFailed', 'checks', 'unequal', 'sinkOver', 'sinkMissing', 'steps', 'seeks', 'oldFoldRight', 'oldFoldWrong', 'crossings'])
console.log('## XB'); rows('xb.jsonl', ['claim', 'planted', 'seeds', 'seedsFailed', 'checks', 'mismatches', 'windowChecks', 'windowBad', 'fullChecks', 'fullBad', 'batches', 'steps', 'bigPathEntries', 'edgeFailed'])
// timed: ranges over runs
const t = lines('timing.jsonl').filter((o) => o.exp === 'E-57')
const groups = new Map()
for (const o of t) { const k = o.bench + ' ' + (o.rows ?? '') + (o.records ? ' records ' + o.records : ''); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o) }
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, p + k + '.') : typeof v === 'number' ? [[p + k, v]] : []))
console.log('## timed (min to max over runs; n = runs)')
for (const [k, os] of groups) {
  const m = new Map()
  for (const o of os) for (const [kk, v] of flat(pick(o, ['nsPerWrite', 'viewNsPerWrite', 'buildMs', 'nsPerRecord', 'r1AndBookkeepingNs', 'r1DropNsPerRecord', 'usPerDiffCommit', 'nsPerDiffRow', 'viewNsPerCommit', 'nsPerChange', 'viewNsPerChange', 'bytesPerBucket', 'ms', 'diffWrites', 'nsPerLeftChange', 'nsPerRightChange', 'bytesPerLeftRow', 'openUsPerRecord', 'stepUs', 'seekMs', 'nsPerAddAndRemove', 'heapMB']))) { if (!m.has(kk)) m.set(kk, []); m.get(kk).push(v) }
  console.log(`${k} (n=${os.length}, endCheck ${os.map((o) => o.endCheck).join(',')})`)
  for (const [kk, vs] of m) console.log(`  ${kk}: ${Math.min(...vs)} to ${Math.max(...vs)}`)
}
for (const o of lines('timing.jsonl')) if (o.loadavg) console.log('load', o.run, o.loadavg.split(' ').slice(0, 3).join(' '), o.cmd.split(' ').slice(-3).join(' '))
