import { fero } from '../../api/index.ts'

// a bare client: node teller.ts <from> <to> <amount> [times]
const [from, to, amount, times = '1'] = process.argv.slice(2)
const led = await fero('ledger')

// the balances: the same live fold as a member's, over the rows this client holds
const add = (b, t) => ({ ...b, [t.from]: (b[t.from] ?? 0) - t.amount, [t.to]: (b[t.to] ?? 0) + t.amount })
const remove = (b, t) => ({ ...b, [t.from]: (b[t.from] ?? 0) + t.amount, [t.to]: (b[t.to] ?? 0) - t.amount })
const balances = led.data.reduce(add, remove, {})

// one line per transfer: the id it got, or the rule it broke, and the balances after it
console.log(`TELLER ${process.pid}`)
for (let i = 0; i < Number(times); i++)
    console.log(await led.methods.transfer({ from, to, amount: Number(amount) }).catch((e) => e.message), balances.snapshot())
await led.destroy()
