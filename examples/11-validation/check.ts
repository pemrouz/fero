import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the last full screen a role drew: it starts with its role word and ends with the object
const screen = (r: Spawned) => r.out.split(/^(?=SHOP |CLIENT )/m).filter((s) => s.trimEnd().endsWith('}')).pop() ?? ''
const rule = (r) => (r.value?.stock ?? 0) >= 0 || 'negative stock'

// the shop: the seed landed, its own bad write did not, and nails keeps 5
const shop = fero.spawn('server.ts')
assert.ok(await until(() => screen(shop).includes('["nails"] rejected: negative stock')), 'the shop refused its own bad write (is this example open in another terminal?)')
assert.ok(screen(shop).includes('["nails"] committed') && screen(shop).trimEnd().endsWith('{ nails: { stock: 5 } }'), 'the seed is its one row, and it kept 5')

// a client: the good row lands on both screens, the bad one on neither, and the client reads the reason
const client = fero.spawn('client.ts')
assert.ok(await until(() => screen(client).includes(`["hammer-${client.pid}"] rejected: negative stock`), 15_000), "the client's bad write came back refused, in the shop's words")
assert.ok(await until(() => screen(client).includes(`["saw-${client.pid}"] committed`) && [shop, client].every((r) => screen(r).includes(`'saw-${client.pid}': { stock: 1 }`))), 'the good row was stamped by the shop and shows on both screens')
assert.ok([shop, client].every((r) => !r.out.includes(`'hammer-${client.pid}'`)), 'the bad row never showed on either screen, not for a moment')

// in this process: the awaited spelling rejects with the same reason, and a seed row the rule refuses stops fero() itself
const c = await fero('shop')
await assert.rejects(c.methods.update({ key: 'axe', value: { stock: -1 } }), (e: { reason: string }) => e.reason === 'negative stock', 'methods.update rejects typed, with the reason')
await assert.rejects(fero('shop', { listen: false, data: { axe: { stock: -1 } }, seams: { validation: rule } }), /data seed row 'axe' rejected by seams\.validation — negative stock/, 'a bad seed row is a config error')
await c.destroy()

for (const r of [shop, client]) assert.equal(await r.stop(), 0, 'stopped cleanly')
console.log('ok 11-validation')
