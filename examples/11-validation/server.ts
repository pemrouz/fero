import { fero } from '../../api/index.ts'

// one rule for every write that enters here: the seed, its own, and what a client sends in
const rule = (r) => (r.value?.stock ?? 0) >= 0 || 'negative stock'
const shop = await fero('shop', { data: { nails: { stock: 5 } }, validation: rule })

// the screen: the writes this shop issued, each with its outcome, then the object
const draw = () => {
    console.clear()
    console.log(`SHOP ${process.pid} — clients ${Object.keys(shop.cluster.snapshot().peers).length}`)
    for (const w of Object.values(shop.cluster.writes.snapshot())) console.log(`${w.key} ${w.state}${w.reason ? `: ${w.reason}` : ''}`)
    console.log(shop.snapshot)
}
for (const v of [shop.data, shop.cluster, shop.cluster.writes]) v.tap(draw)

// its own writes meet the rule too: this one never shows, and nails keeps 5
shop.data.nails = { stock: -1 }
