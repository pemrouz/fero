import { fero } from '../../api/index.ts'

// the folds are built once; the picture is redrawn on every change of the rows or of the group
const d = await fero('fleet')
const regions = d.data.length((r) => r.region), mean = d.data.avg('temp'), latest = d.data.za('at', 8), total = d.data.length()

const draw = () => {
    const { epoch, members } = d.cluster.snapshot()
    console.clear()
    console.log(`FLEET ${process.pid} — members ${Object.keys(members).length} — epoch ${epoch} — facts ${total.snapshot()} — avg ${mean.snapshot()?.toFixed(1) ?? '-'}`)
    console.log(regions.snapshot())
    console.log(latest.snapshot())
}
d.data.tap(draw)
d.cluster.tap(draw)
