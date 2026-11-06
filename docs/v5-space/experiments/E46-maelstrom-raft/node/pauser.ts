// E-46: process pauses for Maelstrom runs. Maelstrom 0.2.4 accepts `--nemesis pause`
// but never emits a pause: its db does not implement jepsen.db/Pause. So this script
// pauses node processes itself, with real SIGSTOP and SIGCONT, as a GC pause or a
// stalled VM would. A paused node reads nothing; Maelstrom queues its messages and
// delivers them late, after SIGCONT.
//
// Usage: node pauser.ts <piddir> <nodeCount> <seconds> <seed> <logfile> [meanGapMs] [minMs] [maxMs]
// It waits until every node has written <piddir>/<node>.pid (written at init), then
// for <seconds> pauses one node at a time: a random gap (exponential, mean meanGapMs),
// then a random node is stopped for a uniform time in [minMs, maxMs]. At the end, or on
// SIGTERM, every node is continued.
import { readdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs'

const [piddir, nStr, secStr, seedStr, logfile, gapStr, minStr, maxStr] = process.argv.slice(2)
const N = Number(nStr), SECONDS = Number(secStr)
const GAP = Number(gapStr ?? 4000), MIN = Number(minStr ?? 200), MAX = Number(maxStr ?? 3000)
let s = (Number(seedStr) * 2654435761) >>> 0 || 1
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()
const out = (line: string) => appendFileSync(logfile, `${new Date().toISOString()} +${Date.now() - t0}ms ${line}\n`)

const pids = new Map<string, number>()
function contAll() { for (const pid of pids.values()) { try { process.kill(pid, 'SIGCONT') } catch {} } }
process.on('SIGTERM', () => { contAll(); out('SIGTERM: continued all'); process.exit(0) })
process.on('SIGINT', () => { contAll(); process.exit(0) })

async function main() {
  while (pids.size < N) {
    if (Date.now() - t0 > 120_000) { out('gave up waiting for pid files'); return }
    if (existsSync(piddir)) for (const f of readdirSync(piddir)) {
      if (f.endsWith('.pid')) pids.set(f.slice(0, -4), Number(readFileSync(`${piddir}/${f}`, 'utf8')))
    }
    await sleep(100)
  }
  const names = [...pids.keys()].sort()
  out(`start: ${names.map(n => `${n}=${pids.get(n)}`).join(' ')} seconds=${SECONDS} gap=${GAP} pause=[${MIN},${MAX}]`)
  const end = Date.now() + SECONDS * 1000
  let count = 0, total = 0
  while (true) {
    const gap = -Math.log(1 - rnd()) * GAP
    if (Date.now() + gap >= end) break
    await sleep(gap)
    const n = names[Math.floor(rnd() * names.length)]
    const ms = Math.round(MIN + rnd() * (MAX - MIN))
    if (Date.now() + ms >= end) break
    try { process.kill(pids.get(n)!, 'SIGSTOP') } catch (e) { out(`stop ${n} failed: ${e}`); continue }
    out(`pause ${n} ${ms}ms`)
    await sleep(ms)
    try { process.kill(pids.get(n)!, 'SIGCONT') } catch {}
    out(`resume ${n}`)
    count++; total += ms
  }
  contAll()
  out(`done: ${count} pauses, ${total} ms paused in all`)
}
main()
