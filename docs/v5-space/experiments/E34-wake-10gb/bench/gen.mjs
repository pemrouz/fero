// E-34: write a snapshot of n rows as fero frames of 256 insert records (fero v4's codec, crc per frame).
//   node gen.mjs <file> <rows> <small|big>
import fs from 'node:fs'
import { C, row, key, out, INSERT } from './common.mjs'
const [file, nArg, shape] = process.argv.slice(2)
const N = +nArg
const fd = fs.openSync(file, 'w')
const t0 = Date.now()
let bytes = 0, pend = [], pendBytes = 0
for (let i = 0; i < N; i += 256) {
  const recs = []
  for (let j = i; j < Math.min(N, i + 256); j++) recs.push({ type: INSERT, key: [], at: key(j), value: row(shape, j, 0) })
  const f = C.encodeFrame(recs)
  pend.push(f); pendBytes += f.length; bytes += f.length
  if (pendBytes > 32 << 20) { fs.writevSync(fd, pend); pend = []; pendBytes = 0 }
}
if (pend.length) fs.writevSync(fd, pend)
fs.fsyncSync(fd); fs.closeSync(fd)
out({ exp: 'E-34', part: 'gen', file: file.split('/').pop(), rows: N, shape, bytes, gb: +(bytes / 1e9).toFixed(2), bytes_per_row: Math.round(bytes / N), seconds: (Date.now() - t0) / 1000 })
