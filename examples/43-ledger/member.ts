import { fero } from '../../api/index.ts'

// a fixed address and a disk, from the port you pass: run this file on 4901, 4902 and 4903
const port = process.argv[2]
// money is facts: a transfer is a row — its money is never edited — and the rule folds a balance from the rows this member holds
const f = await fero('ledger', { listen: `127.0.0.1:${port}`, dir: `./ledger-${port}`, heartbeat: { ms: 100 }, redial: { ms: 30 }, methods: {
    transfer: async ({ from, to, amount }, ctx) => {
        if (!(amount > 0)) throw new Error('amount must be positive')
        let bal = 0
        ctx.data.each((_, t) => { bal += (t.to === from ? t.amount : 0) - (t.from === from ? t.amount : 0) })
        if (from !== 'mint' && bal < amount) throw new Error('insufficient funds')
        const id = crypto.randomUUID().slice(0, 8)
        ctx.data[id] = { from, to, amount, at: Date.now(), outbox: { notify: to } }
        return id
    },
    notified: (id, ctx) => {
        const { outbox, ...rest } = ctx.data.snapshot()[id]
        ctx.data[id] = { ...rest, notified: true }
    },
} })

// the balances: a live fold over the rows — a row in adds it, a row out takes it back
const add = (b, t) => ({ ...b, [t.from]: (b[t.from] ?? 0) - t.amount, [t.to]: (b[t.to] ?? 0) + t.amount })
const remove = (b, t) => ({ ...b, [t.from]: (b[t.from] ?? 0) + t.amount, [t.to]: (b[t.to] ?? 0) - t.amount })
const balances = f.data.reduce(add, remove, {})

// the screen: who I am, the view, the rows and what they add up to
const draw = () => {
    const { epoch, members, peers, writable, me } = f.cluster.snapshot()
    console.clear()
    console.log(`MEMBER ${process.pid} on ${me.listen} — life ${me.origin}`)
    console.log(`epoch ${epoch} — members ${Object.keys(members).length} — peers ${Object.keys(peers).length} — writable ${writable}`)
    console.log(`rows ${f.data.rowCount()} —`, balances.snapshot())
}
f.data.tap(draw)
f.cluster.tap(draw)
