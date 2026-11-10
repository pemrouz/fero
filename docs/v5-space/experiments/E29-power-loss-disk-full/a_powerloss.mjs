// E-29(a): the power-loss tier. A journal writer runs on LazyFS; power is cut; the journal recovers; an oracle
// outside LazyFS checks: every batch whose sync returned is there, nothing that was never written is there, and
// what is there is one unbroken run of batches 1..m with the bytes that were written.
//   node a_powerloss.mjs <work dir> <scenario> <rounds> <seed> [mutant]
// Scenarios: clear     power loss between writes (LazyFS clear-cache): unsynced bytes vanish
//            recycle   the same, with retired segment files reused without clearing (old batches lie after the tail)
//            torn-op   one write is split into parts and only some reach the disk, then LazyFS dies
//            torn-seq  of a run of writes with no sync between, only some reach the disk, then LazyFS dies
// Mutants (each must be caught): noSync, noSeqCheck, resync.
import fs from 'node:fs'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { Journal, KIND } from './journal.mjs'

const [L, SCEN, ROUNDS = '100', SEED = '1', MUTANT = ''] = process.argv.slice(2)
const HERE = new URL('.', import.meta.url).pathname
const SH = HERE + 'lazyfs.sh'
const M = L + '/mnt', ROOT = L + '/root'
let st = Number(SEED) >>> 0
const u32 = () => { st = (st + 0x6d2b79f5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (t ^ (t >>> 14)) >>> 0 }
const int = (n) => u32() % n
const sh = (...a) => execFileSync(SH, a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const opts = { segBytes: SCEN === 'recycle' ? 16384 : 1 << 20, recycle: SCEN === 'recycle', ...(MUTANT ? { [MUTANT]: true } : {}) }

// the oracle: what was written (seq -> checksum of its records), kept outside LazyFS, in this process
const written = new Map()
const sum = (records) => { let c = 0; for (const r of records) c = zlib.crc32(r, c); return c >>> 0 }
const make = () => { const n = 1 + int(3), recs = []; for (let i = 0; i < n; i++) { const b = Buffer.allocUnsafe(10 + int(int(4) === 0 ? 6000 : 300)); for (let k = 0; k < b.length; k += 4) b.writeUInt32LE(u32(), Math.min(k, b.length - 4)); recs.push(b) } return recs }

const violations = []
const stats = { rounds: 0, acked: 0, writtenUnsynced: 0, lostUnsynced: 0, keptUnsynced: 0, cuts: 0, crashes: 0, recovered: 0 }
let firstKept = 1
const check = (round, rec, acked, attempted, what) => {
  const bad = (m) => violations.push({ round, what, acked, attempted, recoveredLast: rec.lastSeq, problem: m })
  if (rec.lastSeq < acked) bad('an acknowledged batch is gone: ' + (rec.lastSeq + 1) + '..' + acked)
  if (rec.lastSeq > attempted) bad('a batch that was never written is there')
  let expect = rec.batches.length ? rec.batches[0].seq : null
  for (const b of rec.batches) {
    if (b.seq !== expect) { bad('the recovered run is broken at ' + b.seq + ' (wanted ' + expect + ')'); break }
    if (written.get(b.seq) !== sum(b.records)) { bad('batch ' + b.seq + ' does not hold the bytes that were written'); break }
    expect++
  }
  if (rec.batches.length && rec.batches[0].seq > firstKept) bad('the log starts at ' + rec.batches[0].seq + ', after the retained start ' + firstKept)
  stats.keptUnsynced += Math.max(0, rec.lastSeq - acked); stats.lostUnsynced += attempted - Math.max(rec.lastSeq, acked)
  if (rec.cut) stats.cuts++
  stats.recovered += rec.batches.length
  for (const s of written.keys()) if (s > rec.lastSeq) written.delete(s) // those batches never happened
}

const fresh = () => { try { sh('down', L) } catch {} fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); fs.mkdirSync(M, { recursive: true }) }
const DIR = M + '/j'

if (SCEN === 'clear' || SCEN === 'recycle') {
  fresh(); sh('up', L); fs.mkdirSync(DIR)
  let j = new Journal(DIR, opts); j.recover()
  for (let round = 1; round <= Number(ROUNDS); round++) {
    stats.rounds++
    const nAck = int(6), nLoose = int(6)
    for (let i = 0; i < nAck; i++) { const r = make(); written.set(j.write(r), sum(r)); if (int(3) === 0 || i === nAck - 1) j.sync() }
    if (nAck) j.sync()
    const acked = j.durable
    for (let i = 0; i < nLoose; i++) { const r = make(); written.set(j.write(r), sum(r)) }
    const attempted = j.seq
    stats.acked += nAck; stats.writtenUnsynced += attempted - acked
    if (SCEN === 'recycle' && int(3) === 0 && acked > 4) { j.retain(acked - 2); firstKept = j.segs[0].first }
    j.close()
    sh('clear', L)                                  // the power loss
    j = new Journal(DIR, opts)
    const rec = j.recover()                         // the restart
    firstKept = rec.batches.length ? Math.min(firstKept, rec.batches[0].seq) : firstKept
    check(round, rec, acked, attempted, 'clear-cache')
    if (rec.batches.length) firstKept = rec.batches[0].seq
  }
  j.close(); sh('down', L)
} else if (SCEN === 'torn-op' || SCEN === 'torn-seq') {
  for (let round = 1; round <= Number(ROUNDS); round++) {
    stats.rounds++
    fresh(); fs.mkdirSync(ROOT + '/j'); written.clear(); firstKept = 1
    // a first life on the plain disk under LazyFS's root: some acknowledged batches
    let j = new Journal(ROOT + '/j', opts); j.recover()
    const pre = 1 + int(5); for (let i = 0; i < pre; i++) { const r = make(); written.set(j.write(r), sum(r)) } j.sync(); j.close()
    const seg = ROOT + '/j/' + fs.readdirSync(ROOT + '/j')[0]
    // the fault, set when LazyFS starts: which write (or run of writes) to tear, and which parts reach the disk
    let inj
    if (SCEN === 'torn-op') { const parts = 2 + int(3); const persist = []; for (let p = 1; p <= parts; p++) if (int(2) === 0) persist.push(p); if (persist.length === 0) persist.push(1 + int(parts)); if (persist.length === parts) persist.shift()
      inj = `[[injection]]\ntype="torn-op"\nfile="${seg}"\noccurrence=${1 + int(12)}\nparts=${parts}\npersist=[${persist}]\n` }
    else { const top = 2 + int(5); const persist = [top]; for (let p = 1; p < top; p++) if (int(2) === 0) persist.unshift(p); persist.sort((a, b) => a - b)
      inj = `[[injection]]\ntype="torn-seq"\nop="write"\nfile="${seg}"\noccurrence=${1 + int(4)}\npersist=[${persist}]\n` }
    fs.writeFileSync(L + '/inj.toml', inj)
    sh('up', L, L + '/inj.toml')
    j = new Journal(DIR, opts); const r0 = j.recover()
    let acked = j.durable, attempted = j.seq, died = false
    try {
      for (let i = 0; i < 60; i++) {
        const r = make(); attempted = j.seq + 1; written.set(attempted, sum(r)); j.write(r)
        if (int(SCEN === 'torn-seq' ? 4 : 2) === 0) { j.sync(); acked = j.durable }
      }
    } catch (e) { if (e.code === 'ENOTCONN' || e.code === 'EIO' || e.code === 'fsync-failed' || e.code === 'ECONNABORTED') died = true; else throw e }
    j.close(); if (died) stats.crashes++
    stats.acked += acked; stats.writtenUnsynced += attempted - acked
    sh('down', L); sh('up', L)                      // LazyFS is dead (the power loss); mount it again, no fault
    j = new Journal(DIR, opts); const rec = j.recover(); j.close()
    check(round, rec, acked, attempted, inj.replace(/\n/g, ' ').replace(/file="[^"]*" /, ''))
    sh('down', L)
  }
} else throw new Error('unknown scenario ' + SCEN)
console.log(JSON.stringify({ scenario: SCEN, mutant: MUTANT || null, seed: Number(SEED), ...stats, violations: violations.length, first: violations.slice(0, 2) }))
