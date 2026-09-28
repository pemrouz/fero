import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the dashboard's last full frame: it starts with FLEET and ends with the latest-facts array
const frame = (r: Spawned) => r.out.split(/^(?=FLEET )/m).filter((s) => s.trimEnd().endsWith(']')).pop() ?? ''

// the dashboard first, alone: nothing to show yet
const dash = fero.spawn('dashboard.ts')
assert.ok(await until(() => frame(dash).includes('members 0 —'), 30_000), 'the dashboard draws an empty fleet (is this example open in another terminal?)')

// the whole story on a thirty-second clock: it audits itself and exits by itself
const fleet = fero.spawn('fleet.ts', ['30'])
assert.equal(await fleet.exited, 0, 'the story ran through')
for (const what of ['members 2: the dead one is voted out', 'members 3: all three restored from their disks']) assert.ok(fleet.out.includes(what), `the chaos happened: ${what}`)
for (const life of ['~2', '~3']) assert.match(fleet.out, new RegExp(`MEMBER \\d+ — pid \\d+ — life \\w+${life}$`, 'm'), `a killed member came back as itself, life ${life}`)
for (const region of ['eu', 'us', 'ap']) assert.match(fleet.out, new RegExp(`^done ${region} persisted [1-9]\\d* committed-unproven \\d+ issued-unknown \\d+$`, 'm'), `the ${region} sensor's ledger was read, with persisted facts in it`)
for (const check of ['convergence', 'durability', 'no phantoms', 'prune']) assert.match(fleet.out, new RegExp(`^audit ${check} ok — `, 'm'), `audit ${check} passed`)
assert.match(fleet.out, /^AUDIT ok$/m, 'the verdict')

// the dashboard followed it all: three members, facts from every region, and the rows left after the prune
assert.ok(dash.out.includes('members 3 —') && ['eu', 'us', 'ap'].every((r) => frame(dash).includes(`${r}: { value: `)), 'the dashboard saw members 3 and counts facts by region')
assert.equal(Number(/facts (\d+)/.exec(frame(dash))?.[1] ?? -1), Number(/the members hold (\d+)/.exec(fleet.out)?.[1]), "the dashboard's total is what every member holds after the prune")
assert.equal(await dash.stop(), 0, 'the dashboard stopped cleanly on Ctrl-C')
console.log('ok 30-fleet-audit')
