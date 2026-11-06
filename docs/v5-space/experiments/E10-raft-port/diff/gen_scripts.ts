// Generates random interaction scripts in etcd's datadriven format, with empty
// expected outputs. The Go reference fills them in (zz_e10_diff_test.go); the TS
// port must then reproduce them byte for byte.
// Usage: node diff/gen_scripts.ts <outdir> <count> <seed> [readindex,restart]
// Extras are commands the Go driver adds on top of etcd's harness, which has neither:
//   readindex  linearizable reads (read-index <node> <ctx>)
//   restart    a crash and restart of one node from its storage (restart <node>); work
//              queued for its append and apply threads is lost, as in a crash
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [outdir, countS, seedS, extra] = process.argv.slice(2)
const extras = (extra ?? '').split(',')
const readIndex = extras.includes('readindex')
const restart = extras.includes('restart')
let reads = 0
const count = Number(countS ?? 100)
let seed = Number(seedS ?? 1) >>> 0
function rnd(): number {
  // xorshift32
  seed ^= seed << 13; seed >>>= 0
  seed ^= seed >>> 17
  seed ^= seed << 5; seed >>>= 0
  return seed / 4294967296
}
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]
const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1))
const chance = (p: number): boolean => rnd() < p

mkdirSync(outdir, { recursive: true })
for (let f = 0; f < count; f++) {
  const n = int(3, 5)
  const voters = Array.from({ length: n }, (_, i) => i + 1)
  const async = chance(0.3)
  const prevote = chance(0.5)
  const checkquorum = chance(0.5)
  const opts: string[] = [`voters=(${voters.join(',')})`, 'index=2']
  if (async) opts.push('async-storage-writes=true')
  if (prevote) opts.push('prevote=true')
  if (checkquorum) opts.push('checkquorum=true')
  if (chance(0.3)) opts.push(`inflight=${int(1, 3)}`)
  if (chance(0.3)) opts.push('step-down-on-removal=true')
  if (chance(0.1)) opts.push('max-committed-size-per-ready=1')
  if (checkquorum && chance(0.2)) opts.push('read-only=lease-based')
  const lines: string[] = []
  const dir = (s: string) => lines.push(s, '----', '', '')
  dir(`log-level ${pick(['debug', 'info', 'info', 'info'])}`)
  dir(`add-nodes ${n} ${opts.join(' ')}`)
  dir(`campaign ${int(1, n)}`)
  dir('stabilize')
  const steps = int(30, 90)
  let prop = 0
  for (let s = 0; s < steps; s++) {
    const x = int(1, n)
    let y = int(1, n)
    if (y === x) y = (x % n) + 1
    const r = rnd()
    if (r < 0.16) dir(`propose ${x} p${++prop}`)
    else if (r < 0.26) dir(`deliver-msgs ${x}`)
    else if (r < 0.30) dir(`deliver-msgs drop=${x}`)
    else if (r < 0.33) dir(`deliver-msgs type=${pick(['MsgApp', 'MsgAppResp', 'MsgHeartbeat', 'MsgVote', 'MsgPreVote'])} ${x}`)
    else if (r < 0.43) dir(`process-ready ${x}`)
    else if (r < 0.46) dir(`process-ready ${x} ${y}`)
    else if (r < 0.52) dir(chance(0.5) ? 'stabilize' : `stabilize ${x} ${y}`)
    else if (r < 0.58) dir(`tick-heartbeat ${x}`)
    else if (r < 0.62) dir(`tick-election ${x}`)
    else if (r < 0.65) dir(`campaign ${x}`)
    else if (r < 0.68) {
      // Conf changes keep nodes 1 and 2 voters, so no change can remove all voters.
      const id = int(3, n)
      const op = pick(['v', 'l', 'r', 'v', 'l'])
      const mode = rnd()
      if (mode < 0.4) lines.push(`propose-conf-change ${x} v1=true`, `${op}${id}`, '----', '', '')
      else if (mode < 0.7) lines.push(`propose-conf-change ${x}`, `${op}${id}`, '----', '', '')
      else if (mode < 0.85) lines.push(`propose-conf-change ${x} transition=${pick(['auto', 'implicit', 'explicit'])}`, `${op}${id} ${pick(['v', 'l'])}${int(3, n)}`, '----', '', '')
      else lines.push(`propose-conf-change ${x}`, '', '----', '', '')
    } else if (r < 0.70) dir(`transfer-leadership from=${x} to=${y}`)
    else if (r < 0.72) dir(`forget-leader ${x}`)
    else if (r < 0.74) dir(`report-unreachable ${x} ${y}`)
    else if (r < 0.77) dir('raft-state')
    else if (r < 0.80) dir(`status ${x}`)
    else if (r < 0.83) dir(`raft-log ${x}`)
    else if (r < 0.86 && async) dir(`process-append-thread ${x}`)
    else if (r < 0.89 && async) dir(`process-apply-thread ${x}`)
    else if (r < 0.90) dir(`log-level ${pick(['debug', 'info', 'warn'])}`)
    else if (readIndex && r < (restart ? 0.94 : 0.95)) dir(`read-index ${x} r${++reads}`)
    else if (restart && r < 0.97) dir(`restart ${x}`)
    else dir(`propose ${x} q${++prop}`)
  }
  dir('stabilize')
  dir('raft-state')
  for (let i = 1; i <= n; i++) dir(`raft-log ${i}`)
  writeFileSync(join(outdir, `fuzz_${String(f).padStart(4, '0')}.txt`), lines.join('\n'))
}
console.log(`wrote ${count} scripts to ${outdir}`)
