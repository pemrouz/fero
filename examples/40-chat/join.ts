import readline from 'node:readline'
import { fero } from '../../api/index.ts'

// a joiner is a bare client: it sorts the room's rows itself, and a line you type is a post
const [name = 'general', nick = 'anon'] = process.argv.slice(2)
const f = await fero(`chat-${name}`)
const log = f.data.az((a, b) => a.at - b.at || a.from.localeCompare(b.from))
const time = (at) => new Date(at).toTimeString().slice(0, 8)
// readline holds the line you are typing, so a redraw can put it back; it hands Ctrl-C on to fero's clean stop
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' })
rl.on('SIGINT', () => process.kill(process.pid, 'SIGINT'))

log.tap(() => {
    console.clear()
    console.log(`CHAT ${name} — ${nick} ${process.pid}`)
    for (const m of log.snapshot()) console.log(`${time(m.at)} <${m.nick}> ${m.text}`)
    if (!rl.closed) rl.prompt(true)
})

for await (const line of rl)
    await f.methods.post({ nick, text: line }).catch((e) => console.log('!', e.message))
