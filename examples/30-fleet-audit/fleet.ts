import { rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { fero, type Spawned } from '../../api/index.ts'

// the whole story on one box: three durable members, three sensors, a fixed chaos schedule, then the audit
const seconds = Number(process.argv[2] ?? 60), t0 = Date.now()
const free = (s = createServer().listen(0), { port } = s.address() as AddressInfo) => (s.close(), port)
const ports = [free(), free(), free()].map(String), regions = ['eu', 'us', 'ap']
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const at = (t: number) => sleep(Math.max(0, t0 + t * 1000 - Date.now()))
const say = (what: string) => console.log(`t=${Math.round((Date.now() - t0) / 1000)}s ${what}`)
const last = (r: Spawned) => r.out.trimEnd().split('\n').pop() ?? ''
const wait = async (what: string, cond: () => boolean, ms: number) => {
    for (const t1 = Date.now(); !cond(); await sleep(25)) if (Date.now() - t1 > ms) throw new Error(`stuck: ${what}`)
    say(what)
}
const formed = (m: Spawned[]) => m.every((r) => /members 3 — writable true/.test(last(r)))

// the story's three disks, wiped at both ends (a run cut short by Ctrl-C leaves them; they are gitignored)
const clean = () => { for (const p of ports) rmSync(`fleet-${p}`, { recursive: true, force: true }) }

clean()
let members = ports.map((p) => fero.spawn('member.ts', [p]))
await wait('the fleet is up: members 3', () => formed(members), 30_000)
const sensors = regions.map((r) => fero.spawn('sensor.ts', [r]))
const watcher = await fero('fleet')

// one member dies: the survivors vote it out once its redial chain gives up, and carry on
await at(5)
members[1].child.kill('SIGKILL')
say(`kill -9 member ${ports[1]}`)
const chain = 30 * (1 + 2 + 4 + 8 + 16 + 32 * 5) + 10 * 30
await wait('members 2: the dead one is voted out', () => [members[0], members[2]].every((r) => /members 2 —/.test(last(r))), 3 * chain)

// the same command again: the same member, back from its disk and voted back in
await at(15)
members[1] = fero.spawn('member.ts', [ports[1]])
await wait(`members 3: ${ports[1]} is back from its disk`, () => formed(members), 30_000)

// all three die at once, and come back from their disks
await at(25)
for (const r of members) r.child.kill('SIGKILL')
say('kill -9 all three')
members = ports.map((p) => fero.spawn('member.ts', [p]))
await wait('members 3: all three restored from their disks', () => formed(members), 30_000)

// the sensors get at least two quiet seconds after the restore, then stop; a ledger is every key a sensor attempted, with the class its reply gave it
await sleep(Math.max(t0 + seconds * 1000 - Date.now(), 2000))
await Promise.all(sensors.map((s) => s.stop()))
const ledger = new Map<string, string>()
for (const [i, s] of sensors.entries()) {
    const n = { persisted: 0, 'committed-unproven': 0, 'issued-unknown': 0 }
    for (const [, key, cls] of s.out.matchAll(/^(\S+) (persisted|committed-unproven|issued-unknown) \d+ ms$/gm)) {
        ledger.set(key, cls)
        n[cls]++
    }
    console.log(`done ${regions[i]} persisted ${n.persisted} committed-unproven ${n['committed-unproven']} issued-unknown ${n['issued-unknown']}`)
}
await sleep(200)

// a look at the watcher, then the audit asks each member itself: a client told one address calls that one and nobody else
const seen = Object.keys(watcher.snapshot)
const readers = await Promise.all(ports.map((p) => fero('fleet', { hosts: [`127.0.0.1:${p}`], rendezvous: false })))
const held = await Promise.all(readers.map((r) => r.methods.read()))
const failed: string[] = []
const audit = (name: string, ok: boolean, detail: string) => {
    console.log(`audit ${name} ${ok ? 'ok' : 'FAILED'} — ${detail}`)
    if (!ok) failed.push(name)
}
const rows = Object.keys(held[0]), persisted = [...ledger].filter(([, c]) => c === 'persisted').map(([k]) => k)
audit('convergence', rows.length > 0 && held.every((h) => isDeepStrictEqual(h, held[0])), `rows on the three members: ${held.map((h) => Object.keys(h).length).join(' ')}`)
audit('durability', persisted.length > 0 && persisted.every((k) => held.every((h) => k in h)), `${persisted.length} persisted facts, ${persisted.filter((k) => !held.every((h) => k in h)).length} missing from a member`)
audit('no phantoms', rows.every((k) => ledger.has(k)), `${rows.filter((k) => !ledger.has(k)).length} rows no sensor attempted`)
const unproven = [...ledger].filter(([, c]) => c !== 'persisted')
console.log(`info ${unproven.length} unproven facts, ${unproven.filter(([k]) => k in held[0]).length} of them landed: a reject is not a rollback`)
console.log(`info the watcher holds ${seen.filter((k) => !(k in held[0])).length} rows no member holds`)

// the operator's method: prune what is older than ten seconds, and every member holds the rest — and only the rest
const cutoff = Date.now() - 10_000
const gone = await readers[0].methods.prune(cutoff)
await sleep(200)
const kept = await Promise.all(readers.map((r) => r.methods.read()))
audit('prune', kept.every((h) => Object.keys(h).length === rows.length - gone && Object.values(h).every((r) => r.at >= cutoff)), `${gone} facts older than 10 s gone, the members hold ${kept.map((h) => Object.keys(h).length).join(' ')}`)
console.log(failed.length ? `AUDIT FAILED ${failed.join(', ')}` : 'AUDIT ok')

for (const f of [watcher, ...readers]) await f.destroy()
for (const r of members) if (await r.stop() !== 0) throw new Error('a member did not stop cleanly')
clean()
