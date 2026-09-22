import assert from 'node:assert'
import { fero } from '../../api/index.ts'

// the file runs once and exits by itself: its two lines are the lesson
const r = fero.spawn('race.ts')
assert.equal(await r.exited, 0, 'race.ts ran to its end and exited 0 (is this example open in another terminal?)')
const [race, fix] = r.out.trim().split('\n')
assert.ok(race && fix, 'race.ts printed its two lines')

// two increments of 0 gave 1: both were stamped by the one owner, in turn, and one was still lost
const stamps = /stamped (\w+):(\d+) and \1:(\d+)/.exec(race)
assert.ok(stamps && Number(stamps[3]) > Number(stamps[2]), 'one owner stamped both writes, one after the other')
assert.ok(race.startsWith('two increments of 0,') && race.endsWith('count is 1 on a, 1 on b'), 'two increments of 0 gave 1 on both members: one is lost')

// two facts fold to 2 on both members
assert.ok(fix.startsWith('two facts { n: 1 },') && fix.endsWith('sum is 2 on a, 2 on b'), 'two facts fold to 2 on both members')
console.log('ok 17-lww-honesty')
