import { fero } from '../../api/index.ts'

// a room is one resource: a message is a new row, and post is the one way in — its rule is thrown here, for everyone
const name = process.argv[2] ?? 'general'
let seq = 0
const room = await fero(`chat-${name}`, { dir: `./room-${name}`, methods: {
    post: ({ nick, text }, ctx) => {
        if (text.length > 280) throw new Error('too long')
        const at = Date.now()
        ctx.data[`${at.toString(36)}-${(seq++).toString(36)}-${ctx.peer}`] = { nick, text, at, from: ctx.peer }
    },
} })
const last = room.data.za('at', 1)
const time = (at) => new Date(at).toTimeString().slice(0, 8)

room.data.tap(() => {
    console.clear()
    console.log(`ROOM ${name} ${process.pid} — messages ${Object.keys(room.snapshot).length}`)
    for (const m of last.snapshot()) console.log(`${time(m.at)} <${m.nick}> ${m.text}`)
})
