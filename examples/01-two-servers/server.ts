import { fero } from '../../api/index.ts'

// run this file in two terminals: each copy counts in its own row, keyed by its pid
const f = await fero('hello', { server: true })
let n = 0

console.log('pid', process.pid)
f.data.tap(() => console.log(`members ${Object.keys(f.cluster.snapshot().members).length}`, f.snapshot))

setInterval(() => { f.data[process.pid] = ++n }, 1000)
