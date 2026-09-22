import { fero } from '../../api/index.ts'

// a bare client finds the members by name; one write, awaited until two of three disks hold it
const c = await fero('vault')
const r = await c.methods.update({ key: String(process.pid), value: 'client' }, { confirm: 'persisted' })

console.log(`CLIENT ${process.pid} — ${r.guarantee} by ${r.origin} seq ${r.seq} epoch ${r.epoch}`)
await c.destroy()
