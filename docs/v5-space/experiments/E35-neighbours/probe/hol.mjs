// Head-of-line probe: one journal, one fdatasync per batch.
// Mode "small": every batch is 64 x 100 B records.
// Mode "mixed": same, but every 10th batch also carries one big record (size from argv).
// Prints p50/p99/max of the batch write+fdatasync time, which every small record in that batch waits.
import fs from 'node:fs'
const mode = process.argv[2], big = Number(process.argv[3] || 1048576), batches = Number(process.argv[4] || 1000)
const path = process.argv[5]
const fd = fs.openSync(path, 'w')
const small = Buffer.alloc(100 * 64, 7), bigBuf = Buffer.alloc(big, 9)
const t = []
for (let i = 0; i < batches; i++) {
  const bufs = mode === 'mixed' && i % 10 === 0 ? [small, bigBuf] : [small]
  const s = process.hrtime.bigint()
  fs.writevSync(fd, bufs)
  fs.fdatasyncSync(fd)
  t.push(Number(process.hrtime.bigint() - s) / 1e6)
}
fs.closeSync(fd); fs.unlinkSync(path)
t.sort((a, b) => a - b)
const q = (p) => t[Math.min(t.length - 1, Math.floor(p * t.length))].toFixed(2)
console.log(JSON.stringify({ mode, big, batches, p50_ms: q(0.5), p90_ms: q(0.9), p99_ms: q(0.99), max_ms: t[t.length - 1].toFixed(2) }))
