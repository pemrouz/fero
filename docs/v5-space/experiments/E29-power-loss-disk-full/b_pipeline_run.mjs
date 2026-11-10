// E-29(b): drive the three-process pipeline through a full follower, a full leader and a full majority.
//   node b_pipeline_run.mjs <work dir> tmpfs|ext4 <base port>
// Prints one JSON line per step with what was seen, then a verdict line. Raw status lines go to <work>/pipeline.log.
import fs from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { Journal } from './journal.mjs'
const [W, KIND = 'tmpfs', PORT = '17310'] = process.argv.slice(2)
const HERE = new URL('.', import.meta.url).pathname
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const p0 = Number(PORT)
for (const n of ['n0', 'n1', 'n2']) execFileSync(HERE + 'fs64.sh', ['up', W, n, KIND])
const log = fs.createWriteStream(W + '/pipeline.log')
const st = [{}, {}, {}], lines = []
const start = (args, i) => { const c = spawn(process.execPath, [HERE + 'b_pipeline.mjs', ...args], { stdio: ['ignore', 'pipe', 'inherit'] }); let rest = ''
  c.stdout.on('data', (d) => { const parts = (rest + d).split('\n'); rest = parts.pop(); for (const l of parts) { log.write(l + '\n'); const o = JSON.parse(l); if (o.line) lines.push({ t: o.t, line: o.line }); else st[i] = o } }); return c }
const ballast = (n, leaveMB) => { const f = `${W}/${n}/ballast`; const free = Number(fs.statfsSync(`${W}/${n}`).bavail) * 4096; const size = free - leaveMB * 1048576; if (size > 0) execFileSync('fallocate', ['-l', String(size), f]) }
const out = (o) => console.log(JSON.stringify(o))
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return -1; await sleep(20) } return Date.now() - t0 }
const rate = async (ms) => { const a = st[0].committed, t = Date.now(); await sleep(ms); return Math.round(((st[0].committed - a) * 1000) / (Date.now() - t)) }
const T0 = Date.now(), at = () => +((Date.now() - T0) / 1000).toFixed(1)

ballast('n1', 14)                                                // follower 1 starts with 14 MB free: it fills first
const f1 = start(['follower', W + '/n1', String(p0 + 1), '1'], 1), f2 = start(['follower', W + '/n2', String(p0 + 2), '2'], 2)
await sleep(300)
const ld = start(['leader', W + '/n0', String(p0), `${p0 + 1},${p0 + 2}`], 0)
await until(() => st[0].committed > 50)
out({ at: at(), step: 'steady', commitsPerSec: await rate(1000), offeredPerSec: 250 })

// 1. one follower full
await until(() => st[1].full === true)
const frozen = st[1].durable
const r1 = await rate(1500)
out({ at: at(), step: 'follower 1 full', follower1AckFrozenAt: frozen, follower1AckNow: st[0].acked[0], stillFrozen: st[0].acked[0] === frozen, commitsPerSecWhileFull: r1, leaderRefused: st[0].refusedFull + st[0].refusedQuorum })
fs.unlinkSync(W + '/n1/ballast')                                 // space is freed (a bigger volume, a dropped resource)
const catchMs = await until(() => st[1].full === false && st[0].acked[0] >= st[0].seq - 2)
out({ at: at(), step: 'follower 1 space freed', caughtUpAfterMs: catchMs, follower1Ack: st[0].acked[0], leaderSeq: st[0].seq })

// 2. the leader (and then everyone: they hold the same bytes) reaches the hard limit
const fullMs = await until(() => st[0].refusedFull > 0, 60000)
await sleep(1000)
out({ at: at(), step: 'leader full', reachedAfterMs: fullMs, leaderSeq: st[0].seq, committed: st[0].committed, refusedDiskFull: st[0].refusedFull, commitsPerSec: await rate(500), freeMB: [st[0].freeMB, st[1].freeMB, st[2].freeMB] })
for (const c of [ld, f1, f2]) c.kill('SIGUSR2')                  // the retention pass (in fero: after a snapshot), no restart
const backMs = await until(() => lines.some((l) => l.line.includes('accepting writes again')))
out({ at: at(), step: 'retention pass on all three', writesBackAfterMs: backMs, commitsPerSec: await rate(1000), freeMB: [st[0].freeMB, st[1].freeMB, st[2].freeMB] })

// 3. both followers full: no majority can store
ballast('n1', 5); ballast('n2', 5)
await until(() => st[1].full === true && st[2].full === true)
await until(() => st[0].refusedQuorum > 0, 20000)
await sleep(500)
out({ at: at(), step: 'both followers full', committedStalledAt: st[0].committed, leaderSeq: st[0].seq, waiting: st[0].seq - st[0].committed, refusedNoWriter: st[0].refusedQuorum, commitsPerSec: await rate(500) })
fs.unlinkSync(W + '/n1/ballast')
const back2 = await until(() => st[0].committed >= st[0].seq - 2 && st[1].full === false)
out({ at: at(), step: 'follower 1 space freed', commitsBackAfterMs: back2, commitsPerSec: await rate(1000) })
fs.unlinkSync(W + '/n2/ballast')
await until(() => st[2].full === false && st[0].acked[1] >= st[0].seq - 2)
await sleep(300)

// stop, then read every journal from disk: the leader's count of each follower's acknowledgements must be on that disk
const final = { committed: st[0].committed, acked: st[0].acked }
for (const c of [ld, f1, f2]) c.kill('SIGTERM')
await sleep(500)
const disk = ['n0', 'n1', 'n2'].map((n) => { const j = new Journal(`${W}/${n}/j`, { layout: 'prealloc', segBytes: 2 << 20 }); const r = j.recover(); j.close(); return { first: r.batches.length ? r.batches[0].seq : null, last: r.lastSeq, cut: r.cut } })
const ok = disk[1].last >= final.acked[0] && disk[2].last >= final.acked[1] && disk.filter((d) => d.last >= final.committed).length >= 2 && disk.every((d) => d.cut === null)
out({ at: at(), step: 'stopped; journals read back', onDisk: disk, leaderSaw: final, everyAckIsOnDisk: disk[1].last >= final.acked[0] && disk[2].last >= final.acked[1], committedIsOnAMajority: disk.filter((d) => d.last >= final.committed).length >= 2, noTornTail: disk.every((d) => d.cut === null) })
out({ lines: lines.map((l) => +((l.t - T0) / 1000).toFixed(1) + 's ' + l.line) })
out({ verdict: ok ? 'pass' : 'FAIL', fs: KIND })
log.end()
for (const n of ['n0', 'n1', 'n2']) { try { execFileSync(HERE + 'fs64.sh', ['down', W, n]) } catch {} }
process.exit(ok ? 0 : 1)
