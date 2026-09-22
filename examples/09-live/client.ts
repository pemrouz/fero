import { fero } from '../../api/index.ts'

// a client: one deposit, then one name's feed opened as a stream — the operators chain on the mirror, here
const bank = await fero('bank')
const who = process.argv[2] ?? 'alice'
await bank.methods.deposit({ who, amount: 5 })

const feed = bank.methods.feed(who), live = feed.open(), total = live.sum('amount'), top = live.za('amount', 3)
live.tap(() => console.log(`${who} total ${total.snapshot()} top`, top.snapshot().map((r) => r.amount)))

// the handle is live — awaited, the same name answers one-shot — and a deposit after the open is one delta
console.log(feed.mode, await feed)
await bank.methods.deposit({ who, amount: 10 })
feed.close()
await bank.destroy()
