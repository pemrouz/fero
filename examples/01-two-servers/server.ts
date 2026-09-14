// 01 · one file, run it twice:   node server.ts   (terminal 1)    node server.ts   (terminal 2)    node check.ts   (proves it)

import { fero } from '../../api/index.ts'

const f = await fero('hello', { server: true })
f.data.tap(() => {
  const c = f.cluster.snapshot()
  console.log(`pid ${process.pid} members ${Object.keys(c.members).length} writable ${c.writable}`, f.snapshot)
})

let n = 0
setInterval(() => { f.data[process.pid] = { ticks: ++n } }, 1000)
