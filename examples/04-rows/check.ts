import assert from 'node:assert'
import { fero } from '../../api/index.ts'

// one run, start to finish: the records it printed, in order, and the refusals
const r = fero.spawn('server.ts')
assert.equal(await r.exited, 0, 'server.ts ran once and exited 0 by itself (is this example open in another terminal?)')
const lines = r.out.trimEnd().split('\n')
const records = lines.filter((l) => /^(insert|update|remove) /.test(l))
const refused = lines.filter((l) => l.startsWith('refused: '))

// the shapes: a new row is an insert at its key, a rewrite an update of the row, a field a deep key
assert.deepEqual(records.slice(0, 3), ['update [] {}', 'insert [] {"qty":1,"status":"new"} at o1', 'update ["o1"] {"qty":1,"status":"paid"}'], 'whole rows: the tap opens with the whole value, then an insert at the key, then an update of the row')
assert.deepEqual(records.slice(3, 6), ['insert [] {"qty":2} at o2', 'update ["o2","status"] "new"', 'update ["o2","status"] "paid"'], 'fields: the row appears from its first field, then one record per field')
const minted = /^insert \[\] \{"qty":3\} at ([0-9a-f-]{36})$/.exec(records[6] ?? '')?.[1]
assert.ok(minted, 'methods.insert minted a uuid as the row key')
assert.equal(records[7], `remove ["${minted}"] {"qty":3}`, 'and methods.remove took that key')
assert.equal(records.length, 8, 'nothing else was written')

// the refusals: three, each with its reason
assert.equal(refused.length, 3, 'three refusals')
assert.ok(refused[0].includes('would operate on the OWNING view'), 'an operator off a row: data refuses it, a row is an address')
assert.ok(refused[1].includes('mints a data-side key') && refused[2].includes('not the resource root'), 'insert() on the view and a whole-root overwrite: fero refuses them')

// the object at the end: one row written whole, one by its fields, and nothing from a refusal
assert.equal(lines.at(-1), "{ o1: { qty: 1, status: 'paid' }, o2: { qty: 2, status: 'paid' } }", 'the snapshot is the two rows')
console.log('ok 04-rows')
