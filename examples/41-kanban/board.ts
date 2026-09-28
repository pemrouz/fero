import { fero } from '../../api/index.ts'
import { rules } from './rules.ts'

// the board: an open server, so editors write cards themselves — under the one rule, on every write that enters
const f = await fero('board', { server: true, seams: { validation: rules } })
const columns = f.data.group((c) => c.status)

for (const v of [f.data, f.cluster]) v.tap(() => {
    console.clear()
    console.log(`BOARD ${process.pid} — editors ${Object.keys(f.cluster.snapshot().peers).length}`)
    console.log(columns.snapshot())
})
