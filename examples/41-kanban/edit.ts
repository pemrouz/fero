import { createInterface } from 'node:readline'
import { fero } from '../../api/index.ts'
import { rules } from './rules.ts'

// an editor: a client that carries the board's rule, so its own bad write is refused here and never leaves
const [who, ...first] = process.argv.slice(2)
const f = await fero('board', { seams: { validation: rules } })
const columns = f.data.group((c) => c.status)
// readline holds the line you are typing, so a redraw can put it back (on a fresh row: prevRows = 0); it hands Ctrl-C on to fero's clean stop
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '' })
rl.on('SIGINT', () => process.kill(process.pid, 'SIGINT'))

// the screen: my last three writes, each with its outcome, then the board
for (const v of [f.data, f.cluster, f.cluster.writes]) v.tap(() => {
    console.clear()
    console.log(`EDIT ${who} ${process.pid}`)
    for (const w of Object.values(f.cluster.writes.snapshot()).slice(-3)) console.log(`${w.key} ${w.state}${w.reason ? `: ${w.reason}` : ''}`)
    console.log(columns.snapshot())
    if (!rl.closed) { rl.prevRows = 0; rl.prompt(true) }
})

// add <id> <title> · move <id> <column> · set <id> <field> <text> — each one a write to a field of one card
const cmd = {
    add: (id, ...title) => f.data[id].patch([['status', 'todo'], ['title', title.join(' ')]]),
    move: (id, column) => { f.data[id].status = column },
    set: (id, field, ...text) => { f.data[id][field] = text.join(' ') },
}
const run = ([verb, ...args]) => cmd[verb]?.(...args)

// one command from the command line, then every line typed
if (first.length) run(first)
rl.on('line', (line) => run(line.trim().split(/\s+/)))
