import assert from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { fero } from '../../api/index.ts'
import { verifyReplay } from '../../tools/debug/model.mjs'

// the story runs once and exits by itself: its lines are the lesson, its capture file the evidence
rmSync('story.capture.json', { force: true })
const r = fero.spawn('story.ts')
assert.equal(await r.exited, 0, 'story.ts ran to its end and exited 0 (is this example open in another terminal?)')
const [race, history, cut, open] = r.out.trim().split('\n')

// act 1: two origins stamped seq 1 — the higher id won the tie, everywhere
const tie = /^race: 'from a' is a:(\d+), 'from b' is b:(\d+) → hot is 'from b' on a, b, c$/.exec(race)
assert.ok(tie && tie[1] === tie[2], `the open window: a and b stamp the same seq, b wins the tie on every member — ${race}`)
// act 2: one origin stamped both, its own first — the later stamp won, everywhere
const turn = /^history: 'a again' is b:(\d+), 'b again' is b:(\d+) → hot is 'a again' on a, b, c$/.exec(history)
assert.ok(turn && Number(turn[1]) > Number(turn[2]), `history: b stamped both writes in turn, no election — ${history}`)
// act 3: the cut healed, and the file is where the line says
assert.match(cut, /^cut: a dropped its link to c, 'the cut' is c:\d+ → during is 'the cut' on a, b, c$/, `the cut healed — ${cut}`)
assert.equal(open, 'open it: npm run debug -- examples/22-time-travel/story.capture.json', 'the open-it line names the capture')

// the capture names its own event kinds: the election, the cut, the heal by anti-entropy, and three members that agree
const cap = JSON.parse(readFileSync('story.capture.json', 'utf8'))
const events = (uuid: string, kind: string) => cap.nodes.find((n: { uuid: string }) => n.uuid === uuid).journal.filter((e: { kind: number }) => e.kind === cap.vocab[kind])
assert.ok(['b', 'c'].some((u) => events(u, 'lwwSkip').some((e: { a: string, b: number }) => e.a === 'a' && e.b === Number(tie![1]))), "a real election: a's stamp was set aside where b's was already held (lwwSkip)")
assert.ok(events('c', 'aeShip').some((e: { t: number, a: string }) => e.a === 'a' && e.t > (events('c', 'linkDown')[0]?.t ?? Infinity)), 'the heal: after linkDown, c shipped a the suffix it missed (aeShip)')
assert.ok(cap.nodes.every((n: { stateHash: unknown, dropped: number }) => typeof n.stateHash === 'number' && n.stateHash === cap.nodes[0].stateHash && n.dropped === 0), 'the three members converged, and no journal overflowed')
assert.ok(verifyReplay(cap).every((v: { ok: boolean }) => v.ok), "the viewer's replay reproduces each member's end state")
rmSync('story.capture.json')
console.log('ok 22-time-travel')
