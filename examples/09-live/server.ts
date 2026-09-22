import { fero } from '../../api/index.ts'

// a bank: feed is a method that returns a view, not a value, so a client can open it as a stream — deposit is the one way in
const bank = await fero('bank', {
    data: { opening: { who: 'alice', amount: 100 } },
    methods: {
        feed: (who, ctx) => ctx.data.filter((r) => r.who === who),
        deposit: ({ who, amount }, ctx) => { ctx.data[crypto.randomUUID()] = { who, amount } },
    },
})

bank.data.tap(() => {
    console.clear()
    console.log(`BANK ${process.pid} — clients ${Object.keys(bank.cluster.snapshot().peers).length}`)
    console.log(bank.snapshot)
})
