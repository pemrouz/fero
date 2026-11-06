// P-05 websocket fan-out by room, as API.md §7 writes it. `wss` is the app's own socket server
// (API.md's env.d.ts); here it is passed in. One addition (D10): a joining socket gets the room's
// snapshot first, else it sees only what is said after it joined.
import { fero } from '../proto/index.ts'
interface Socket { send(s: string): void; on(ev: 'message', fn: (text: string) => void): void; on(ev: 'close', fn: () => void): void }
type Wss = { on(ev: 'connection', fn: (ws: Socket, room: string) => void): void }

// ── chat.ts, a server: a room is a partition, a message a row
export const chatServer = () => fero('chat', { server: true, partition: { before: '/' }, rows: { ttl: '1d' }, history: '1d' })

// ── web.ts, a webserver: a client that follows only the rooms its sockets joined
export const web = async (wss: Wss) => {
  const chat = await fero('chat', { cache: { memory: '200MB' } })
  wss.on('connection', (ws, room) => {
    const live = chat.follow(room)                       // snapshot, then deltas, encoded once per link
    live.ready.then(() => ws.send(JSON.stringify(live.snapshot())))   // added: the snapshot first
    live.tap((r: unknown) => ws.send(JSON.stringify(r)))
    ws.on('message', (text) => { chat.data[`${room}/${fero.id()}`] = { text, at: fero.now() } })
    ws.on('close', () => live.close())
  })
  return chat
}
