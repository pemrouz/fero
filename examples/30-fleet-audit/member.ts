import { fero } from '../../api/index.ts'

// one of three: a fixed address and a disk from the port you pass; sensors write only through record, an operator prunes
const port = process.argv[2]
const fleet = fero('fleet', { listen: `127.0.0.1:${port}`, dir: `./fleet-${port}`, heartbeat: { ms: 100 }, redial: { ms: 30 }, methods: {
    // a fact is one row, written by this member and awaited until two of three disks hold it: the reply is the rung it reached
    record: async (fact) => (await fleet).methods.update(fact, { confirm: 'persisted', timeout: 4000 }).then((r) => r.guarantee, (e) => e.reached),
    // collect the old facts, then delete them, and say how many
    prune: (olderThan, ctx) => {
        const old = []
        ctx.data.each((k, r) => { if (r.at < olderThan) old.push(k) })
        for (const k of old) delete ctx.data[k]
        return old.length
    },
} })
const f = await fleet

// one line per change of the view, with the rows held at that moment
const view = f.cluster.to(({ epoch, members, writable }) => `epoch ${epoch} — members ${Object.keys(members).length} — writable ${writable}`)
console.log(`MEMBER ${port} — pid ${process.pid} — life ${f.cluster.me.snapshot().origin}`)
view.tap(() => console.log(`${view.snapshot()} — rows ${Object.keys(f.snapshot).length}`))
