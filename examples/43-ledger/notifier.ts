import { fero } from '../../api/index.ts'

// the server of the notices, and a client of the ledger
const notices = await fero('notices', { server: true })
const led = await fero('ledger')

console.log(`NOTIFIER ${process.pid}`)
// a new row is an insert at its key — one carrying an intent is delivered: the notice under its id, then the intent cleared through the door
led.data.tap(async (r) => {
    if (r.type !== 'insert' || !r.value.outbox) return
    const id = r.at, to = r.value.outbox.notify
    notices.data[`n-${id}`] = { to, amount: r.value.amount }
    const cleared = await led.methods.notified(id, { retry: true }).then(() => 'cleared', (e) => e.message)
    console.log(`n-${id} → ${to} ${r.value.amount} — ${cleared}`)
})
