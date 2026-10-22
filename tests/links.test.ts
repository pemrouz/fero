//! ── tests/links — the link sockets' own rules, on real sockets (V4-NN) ──────────────────────────────
// Nagle's algorithm is off on every link socket: shell/runtime.ts #wire calls setNoDelay(true) before any byte can
// leave (tests/latency.perf.ts pins what it buys: a writing method call and a forwarded update in about 1 ms, not 43).
//! How the check sees the sockets: a PASSIVE spy on two public methods of net.Socket's prototype, installed for one
// test and taken off after. It records each socket setNoDelay(true) was called on and each TCP socket the process
// writes to, and calls straight through, so nothing behaves differently. A socket written to before its
// setNoDelay(true) is the bug. (If #wire ever turns Nagle off another way, the `noDelay` option of net.connect or
// net.createServer, this spy does not see it and the test goes red: point the spy at the new spelling.)

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import net from 'node:net'
import { fero } from '../api/index.ts'
import { snapshot } from '../api/substrate.ts'
import { ports, until } from '#utils'
import type { Context } from '../api/methods.ts'
import type { Fero } from '../api/types.ts'

type Spy = { off: () => void; written: Set<net.Socket>; early: string[]; noDelay: WeakSet<net.Socket> }
//! spy — install the passive spy; `off` restores the prototype exactly as it was (own property or inherited)
const spy = (): Spy => {
  const proto = net.Socket.prototype as unknown as Record<string, unknown>
  const own = { write: Object.getOwnPropertyDescriptor(proto, 'write'), setNoDelay: Object.getOwnPropertyDescriptor(proto, 'setNoDelay') }
  const write = net.Socket.prototype.write, setNoDelay = net.Socket.prototype.setNoDelay
  const s: Spy = { off: () => {}, written: new Set(), early: [], noDelay: new WeakSet() }
  proto.setNoDelay = function (this: net.Socket, on?: boolean) {
    if (on === false) s.noDelay.delete(this); else s.noDelay.add(this)
    return setNoDelay.call(this, on)
  }
  proto.write = function (this: net.Socket, ...args: unknown[]) {
    //! TCP only: the test runner's own stdout is a pipe, a net.Socket with no remote port
    if (typeof this.remotePort === 'number') {
      if (!s.written.has(this) && !s.noDelay.has(this)) s.early.push(`${this.localPort} -> ${this.remotePort}`)
      s.written.add(this)
    }
    return (write as (...a: unknown[]) => boolean).apply(this, args)
  }
  s.off = () => {
    for (const k of ['write', 'setNoDelay'] as const) {
      const d = own[k]
      if (d) Object.defineProperty(proto, k, d); else delete proto[k]
    }
  }
  return s
}

const members = (f: Fero) => Object.keys((snapshot(f.cluster) as { members: Record<string, string> }).members ?? {}).length

test('every link socket turns Nagle off before its first byte: member links both ways, a client link, a method call, the #directory host and its clients', async () => {
  const s = spy()
  const live: Fero[] = []
  try {
    const [pa, pb, pm, rz] = [await ports.free(), await ports.free(), await ports.free(), await ports.free()]
    const name = `links-${process.pid}`, base = { signals: false } as const, fast = { heartbeat: { ms: 50 }, redial: { ms: 30 } }
    //! two servers that both dial (the keeper rule drops one link per pair: dialed and accepted sockets both write)
    const a = await fero(name, { ...base, rendezvous: false, listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`] }); live.push(a)
    const b = await fero(name, { ...base, rendezvous: false, listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`] }); live.push(b)
    assert.ok(await until(() => members(a) === 2 && members(b) === 2, 10_000), 'a and b formed one view')
    //! a client of a, writing a row that may be owned by either server (forwarded when it is b's)
    const c = await fero(name, { ...base, rendezvous: false, hosts: [`127.0.0.1:${pa}`] }); live.push(c)
    for (let i = 0; i < 4; i++) await (c.methods.update as (r: unknown, o: unknown) => Promise<unknown>)({ key: `c${i}`, value: { i } }, { confirm: 'committed', timeout: 10_000 })
    //! a methods server and its client: a call that writes
    const m = await fero(`${name}-m`, { ...base, rendezvous: false, listen: `127.0.0.1:${pm}`, methods: { put(i: number, ctx: Context) { (ctx.data as Record<string, unknown>)['p' + i] = { i }; return i } } }); live.push(m)
    const k = await fero(`${name}-m`, { ...base, rendezvous: false, hosts: [`127.0.0.1:${pm}`] }); live.push(k)
    assert.equal(await (k.methods.put as (i: number) => Promise<number>)(7), 7)
    //! the #directory: a server on a private rendezvous hosts it and registers; a bare client finds the server through it
    const d = await fero(`${name}-d`, { ...base, ...fast, server: true, rendezvous: `127.0.0.1:${rz}` }); live.push(d)
    const e = await fero(`${name}-d`, { ...base, ...fast, rendezvous: `127.0.0.1:${rz}` }); live.push(e)
    d.data.x = { n: 1 }
    assert.ok(await until(() => (snapshot(e.data) as Record<string, unknown>).x !== undefined, 10_000), 'the client found the server through the directory and holds its row')
    //! non-vacuity: the spy saw the sockets it is meant to judge, the directory's included
    const socks = [...s.written]
    assert.ok(socks.length >= 10, `the spy saw ${socks.length} written TCP sockets (expected at least 10)`)
    assert.ok(socks.some((x) => x.localPort === rz), 'the directory host wrote on an accepted socket')
    assert.ok(socks.some((x) => x.remotePort === rz), 'a directory client wrote on a dialed socket')
    assert.ok(socks.some((x) => x.localPort === pm) && socks.some((x) => x.remotePort === pm), 'the method link wrote both ways')
    assert.deepEqual(s.early, [], 'no link socket was written to before setNoDelay(true)')
  } finally {
    s.off()
    for (const f of live.reverse()) await f.destroy()
  }
})
