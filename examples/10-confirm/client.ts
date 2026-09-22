import { fero } from '../../api/index.ts'

// the same write awaited at three rungs: the reply names the rung it PROVED, or how far it got
const c = await fero('ledger')
const at = ({ origin, seq, epoch }) => `by ${origin} seq ${seq} epoch ${epoch}`

// a majority needs two: wait for the committed view before writing
await new Promise<void>((up) => c.cluster.tap(() => { if (c.cluster.snapshot().epoch >= 1) up() }))

console.log(`CLIENT ${process.pid}`)
for (const [value, confirm] of [[1, 'committed'], [2, 'replicated'], [3, 'persisted']] as const)
    await c.methods.update({ key: 'k', value }, { confirm, timeout: 3000 })
        .then((r) => console.log(`k=${value} ${r.guarantee}`, at(r)))
        .catch((e) => console.log(`k=${value} ${e.guarantee} ${e.reason} — reached ${e.reached}`, at(e.localCommit)))
console.log(c.snapshot)
await c.destroy()
