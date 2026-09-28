import { fero } from '../../api/index.ts'

// a scripted joiner: it posts n lines 300 ms apart, waits until the room shows them and holds at least `all`, prints the room, and leaves
const [name = 'general', nick = 'bot'] = process.argv.slice(2), n = Number(process.argv[4] ?? 5), all = Number(process.argv[5] ?? n)
const f = await fero(`chat-${name}`)
const log = f.data.az((a, b) => a.at - b.at || a.from.localeCompare(b.from))
const time = (at) => new Date(at).toTimeString().slice(0, 8)

for (let i = 1; i <= n; i++) {
    await f.methods.post({ nick, text: `line ${i}` })
    await new Promise((r) => setTimeout(r, 300))
}
await new Promise((seen) => log.tap(() => { if (log.snapshot().filter((m) => m.nick === nick).length >= n && log.snapshot().length >= all) seen() }))
console.log(`BOT ${nick} ${process.pid} — sees ${log.snapshot().length}`)
for (const m of log.snapshot()) console.log(`${time(m.at)} <${m.nick}> ${m.text}`)
await f.destroy()
