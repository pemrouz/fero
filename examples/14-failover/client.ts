import { fero } from '../../api/index.ts'

// a bare client dials every server the directory lists, and one of them feeds its live handle
const c = await fero('feed')

// with an argument it marks the feed first — safe to retry: setting one cell twice is setting it once
if (process.argv[2]) await c.methods.mark(process.argv[2], { retry: true })
const live = c.methods.feed().open()

// the header is the cluster's view, the object is the stream: redraw when either moves
const draw = () => {
    console.clear()
    console.log(`CLIENT ${process.pid} — peers ${Object.keys(c.cluster.snapshot().peers).length}`)
    console.log(live.snapshot())
}
live.tap(draw)
c.cluster.tap(draw)
