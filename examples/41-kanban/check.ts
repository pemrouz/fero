import assert from 'node:assert'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// the last full screen a role drew (it starts with its role word and ends with the columns object), one card on it, a ring as an editor prints it
const screen = (r: Spawned) => r.out.split(/^(?=BOARD |EDIT )/m).filter((s) => s.trimEnd().endsWith('}')).pop() ?? ''
const card = (r: Spawned, id: string) => new RegExp(`(\\w+): \\{ ${id}: \\{ status: '\\1', title: '([^']*)' \\}`).exec(screen(r))?.slice(1).join()
const ring = (f) => Object.values(f.cluster.snapshot().writes).map((w) => `${w.key} ${w.state}${w.reason ? `: ${w.reason}` : ''}`)

// an editor adds a card by its fields: it lands in todo on the board and on the editor
const board = fero.spawn('board.ts')
const ada = fero.spawn('edit.ts', ['ada', 'add', 'c1', 'write', 'the', 'docs'])
assert.ok(await until(() => [board, ada].every((r) => card(r, 'c1') === 'todo,write the docs'), 30_000), 'c1 is in todo with its title on both screens (is this example open in another terminal?)')

// two writers, two fields of one card: both survive — a card written by its fields is one cell per field
const c = await fero('board')
assert.ok(await until(() => c.snapshot.c1?.status === 'todo'), 'a client with no rule of its own follows the board')
const bob = fero.spawn('edit.ts', ['bob', 'move', 'c1', 'doing'])
c.data.c1.title = 'write the docs first'
assert.ok(await until(() => [board, ada, bob].every((r) => card(r, 'c1') === 'doing,write the docs first'), 15_000), "bob's move and the retitle both landed, and every screen groups c1 under doing")

// the rule at both ends: an editor refuses its own bad write before it leaves, a client that carries none is refused at the board
const eve = fero.spawn('edit.ts', ['eve', 'move', 'c1', 'nowhere'])
assert.ok(await until(() => screen(eve).includes('["c1","status"] rejected: unknown column')), "eve's own copy of the rule refused her move")
assert.ok(!eve.out.includes('["c1","status"] pending'), 'and it never went pending: refused before it left')
c.data.c1 = { status: 'todo', title: 'x' }
c.data.c1.status = 'nowhere'
assert.ok(await until(() => ['["c1"] rejected: this board writes fields, never whole rows', '["c1","status"] rejected: unknown column'].every((row) => ring(c).includes(row))), "a whole row and an unknown column are refused, in the board's words")
assert.deepEqual(c.data.group((x) => x.status).snapshot(), { doing: { c1: { status: 'doing', title: 'write the docs first' } } }, 'the columns are unchanged: c1 in doing, both edits kept, nothing from a refusal')
await c.destroy()

for (const r of [ada, bob, eve, board]) assert.equal(await r.stop(), 0, 'stopped cleanly')
console.log('ok 41-kanban')
