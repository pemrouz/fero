// E-29(a): how slow is the tier? Appends of one 200 B record, each followed by fdatasync, for 2 s, through LazyFS
// and on the plain disk beside it. A planning number (how many fault rounds fit in a test run), not a benchmark.
import fs from 'node:fs'
import { Journal } from './journal.mjs'
const [L] = process.argv.slice(2)
for (const [name, dir] of [['through LazyFS', L + '/mnt/rate'], ['plain disk', L + '/plain-rate']]) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true })
  const j = new Journal(dir, {}); j.recover()
  const rec = [Buffer.alloc(200, 7)], t0 = Date.now(); let n = 0
  while (Date.now() - t0 < 2000) { j.write(rec); j.sync(); n++ }
  j.close()
  console.log(JSON.stringify({ rate: name, appendsWithSyncPerSec: Math.round(n / ((Date.now() - t0) / 1000)), loadavg: fs.readFileSync('/proc/loadavg', 'utf8').trim() }))
}
