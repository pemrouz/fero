import { fero } from '../../api/index.ts'

// a write is a record: a tap with a parameter sees each one as it commits
const f = await fero('orders', { server: true })
f.data.tap((r) => console.log(`${r.type} ${JSON.stringify(r.key)} ${JSON.stringify(r.value)}${r.at ? ` at ${r.at}` : ''}`))

// whole rows: a write is the row
f.data.o1 = { qty: 1, status: 'new' }
f.data.o1 = { ...f.snapshot.o1, status: 'paid' }

// fields: a write is one field, and the row appears from its fields
f.data.o2.patch([['qty', 2], ['status', 'new']])
f.data.o2.status = 'paid'

// methods.insert mints the row key, and methods.remove takes it
const { key } = await f.methods.insert({ value: { qty: 3 } })
await f.methods.remove({ key })

// three refusals, nothing lands: data refuses an operator off a row, fero refuses insert() on the view and a whole-root overwrite
for (const bad of [() => f.data.o1.filter(() => true), () => f.data.insert({ qty: 9 }), () => f.data.update({})])
    try { bad() } catch (e) { console.log('refused:', (e as Error).message.split(' — ')[0]) }

console.log(f.snapshot)
await f.destroy()
