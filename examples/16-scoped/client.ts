import { fero } from '../../api/index.ts'

// a client names the members, and read() is the whole resource: the member that takes the call gathers it
const c = await fero('shards', { hosts: process.argv.slice(2).map((p) => `127.0.0.1:${p}`), rendezvous: false })
const all = await c.methods.read()

console.log(`CLIENT ${process.pid} — ${Object.keys(all).length} rows`)
await c.destroy()
