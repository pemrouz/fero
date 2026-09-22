import { fero } from '../../api/index.ts'

// a method runs here, on the server; declaring methods is the door: clients change data only through them
let n = 0
const bank = await fero('bank', { data: { genesis: { who: 'alice', amount: 100 } }, methods: {
    deposit: async ({ who, amount }, ctx) => {
        ctx.data[`deposit-${process.pid}-${++n}`] = { who, amount }
        await ctx.flush()
        return Object.values(ctx.data.snapshot()).filter((r) => r.who === who).reduce((t, r) => t + r.amount, 0)
    },
    fail: () => { throw new Error('nope') },
    whoami: (_, ctx) => ctx.peer,
} })

bank.data.tap(() => console.log(`SERVER ${process.pid}`, bank.snapshot))
