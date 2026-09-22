import { fero } from '../../api/index.ts'

// a sale is a fact: one new row per event, never edited — every number below is a live fold over the rows
const till = await fero('till', { server: true })
const facts = till.data.to((rows) => Object.values(rows).map((r) => r.amount).join(' + '))
const sum = till.data.sum('amount'), n = till.data.length(), avg = till.data.avg('amount'), min = till.data.min('amount')
const max = till.data.max('amount'), median = till.data.median('amount'), p75 = till.data.percentile('amount', 75)
const big = till.data.filter((r) => r.amount > 5).sum('amount')
const cash = till.data.reduce((a, r) => a + r.amount, (a, r) => a - r.amount, 20)

// a tap on a scalar fires once when attached, then whenever the number changes — the others have settled by then
sum.tap(() => console.log(`${facts.snapshot() || 'nothing'} = ${sum.snapshot()}`))

for (const [i, amount] of [3, 8, 4, 9, 6].entries()) till.data[`sale-${process.pid}-${i}`] = { amount }
console.log({ n: n.snapshot(), avg: avg.snapshot(), min: min.snapshot(), max: max.snapshot(), median: median.snapshot(), p75: p75.snapshot(), big: big.snapshot(), cash: cash.snapshot() })
await till.destroy()
