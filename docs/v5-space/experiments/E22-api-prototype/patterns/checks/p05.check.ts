// P-05's check (REQUIREMENTS P-05): two webservers, each following only the rooms its sockets
// joined; sockets on both say things in three rooms under a leader change and a move. Order per
// room (each socket's messages are the room's committed order); every message reaches every socket
// in its room; a webserver never holds a room it does not follow. Not modelled: encoding once per
// link, and a reconnect within history (the sim has no links).
import { check, report, isMain, servers, committed, sleep } from './common.ts'
import { chatServer, web } from '../p05-rooms.ts'

class Sock { sent: string[] = []; h: Record<string, ((x?: any) => void)[]> = {}
  send(s: string) { this.sent.push(s) }
  on(ev: string, fn: (x?: any) => void) { (this.h[ev] ??= []).push(fn) }
  emit(ev: string, x?: unknown) { for (const f of this.h[ev] ?? []) f(x) } }
class Wss { fn: ((ws: any, room: string) => void) | null = null
  on(_ev: 'connection', fn: (ws: any, room: string) => void) { this.fn = fn }
  join(room: string) { const s = new Sock(); this.fn!(s, room); return s } }

export const run = () => check('p05-rooms', async (c) => {
  await servers(c, 3, chatServer)
  const [w1, w2] = c.procs('w1', 'w2')
  const wss1 = new Wss(), wss2 = new Wss()
  await w1.run(() => web(wss1)); await w2.run(() => web(wss2))
  const rooms: Record<string, [any, Sock][]> = { r1: [], r2: [], r3: [] }
  const join = (p: any, wss: Wss, room: string) => p.run(() => rooms[room].push([p, wss.join(room)]))
  join(w1, wss1, 'r1'); join(w1, wss1, 'r2'); join(w2, wss2, 'r2'); join(w2, wss2, 'r3'); join(w2, wss2, 'r3')
  await c.settle()
  c.chaos({ leaderChanges: 1, moves: 1, within: 20 })
  for (let i = 0; i < 8; i++) for (const room of ['r1', 'r2', 'r3']) {
    const [p, s] = rooms[room][i % rooms[room].length]
    p.run(() => s.emit('message', `${room}:${i}`))
    await sleep(1)
  }
  await c.w.advance('5s')
  for (const room of ['r1', 'r2', 'r3']) {
    const order = committed(c, 'chat').filter((e: any) => e.p === room && e.k === 'w').map((e: any) => e.recs[0].value.text)
    c.eq(order.length, 8, `${room}: every message committed`)
    for (const [, s] of rooms[room]) {
      const got = s.sent.slice(1).map((x) => JSON.parse(x)).filter((r) => r.type === 'insert' || r.type === 'update').map((r) => r.value?.text).filter(Boolean)
      c.eq(got, order, `${room}: a socket gets every message, in the room's order`)
    }
  }
  const held = (p: any) => [...(c.stack.l3.replicaIf(p, 'chat')!.held?.keys() ?? [])].sort()
  c.eq(held(w1), ['r1', 'r2'], 'webserver 1 holds only its rooms')
  c.eq(held(w2), ['r2', 'r3'], 'webserver 2 holds only its rooms')
}, { seeds: 60 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
