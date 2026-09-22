import { fero } from '../../api/index.ts'

// a client calls the server's methods: each await is one call, answered after the server committed
const bank = await fero('bank')

console.log(`CLIENT ${process.pid} — me ${bank.cluster.me.snapshot().uuid}`)
console.log('deposit', await bank.methods.deposit({ who: 'alice', amount: 5 }))
console.log('deposit', await bank.methods.deposit({ who: 'alice', amount: 5 }))
console.log('whoami', await bank.methods.whoami())
console.log('read', await bank.methods.read('genesis'))
await bank.methods.fail().catch((e) => console.log('fail', e.message))
await bank.methods.nosuch().catch((e) => console.log('nosuch', e.message))
await bank.methods.update({ key: 'hack', value: { who: 'alice', amount: 1000 } }).catch((e) => console.log('update', e.reason))
await bank.destroy()
