import { fero } from '../../api/index.ts'

// one of three: feed streams the whole object to a client, and mark is the one way a client writes to it
const f = await fero('feed', { server: true, heartbeat: { ms: 100 }, redial: { ms: 30 }, methods: {
    feed: (_, ctx) => ctx.data,
    mark: (v, ctx) => { ctx.data.after = v },
} })
let n = 0

f.data.tap(() => {
    console.clear()
    console.log(`SERVER ${process.pid} — members ${Object.keys(f.cluster.snapshot().members).length}`)
    console.log(f.snapshot)
})

// a count in its own row, twice a second, so the picture keeps moving
setInterval(() => { f.data[process.pid] = ++n }, 500)
