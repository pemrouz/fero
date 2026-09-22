import { fero } from '../../api/index.ts'

// dir makes the node durable: run this file again and it is the SAME node, with its rows back
const f = await fero('notes', { dir: './notes', data: { seed: process.pid } })
const me = f.cluster.me.snapshot()

f.data.tap(() => {
    console.clear()
    console.log(`NOTES ${process.pid} — life ${me.origin}`)
    console.log(f.snapshot)
})

// one row per life, keyed by its origin, awaited at 'persisted': alone, that is this one disk
const { guarantee } = await f.methods.update({ key: me.origin, value: new Date().toTimeString().slice(0, 8) }, { confirm: 'persisted' })
console.log(guarantee)
