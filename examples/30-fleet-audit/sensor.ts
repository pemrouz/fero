import { fero } from '../../api/index.ts'

// a fact a second through the door: my ledger is what the reply said, one line per fact, whatever the fleet is doing
const region = process.argv[2]
const s = await fero('fleet')
let n = 0

console.log(`SENSOR ${region} — pid ${process.pid}`)
setInterval(() => {
    const key = `${region}-${++n}`, t0 = Date.now()
    s.methods.record({ key, value: { region, temp: 20 + Math.round(Math.random() * 50) / 10, at: t0 } })
        .then((rung) => rung === 'persisted' ? 'persisted' : rung === 'committed' ? 'committed-unproven' : 'issued-unknown', () => 'issued-unknown')
        .then((cls) => console.log(`${key} ${cls} ${Date.now() - t0} ms`))
}, 1000)
