import { fero } from '../../api/index.ts'

// a client's write is a request: it waits in cluster.writes until a server stamps it
const f = await fero('notes')
let n = 0

f.cluster.tap(() => {
    console.clear()
    console.log(`CLIENT ${process.pid} — me ${f.cluster.me.snapshot().uuid}`)
    for (const w of Object.values(f.cluster.snapshot().writes).slice(-3)) console.log(`${w.key} ${w.state}${w.origin ? ` by ${w.origin}` : ''}`)
    console.log(f.snapshot)
})

// a note every 2 seconds, carrying the time it was written
setInterval(() => { f.data[`note-${++n}`] = new Date().toTimeString().slice(0, 8) }, 2000)
