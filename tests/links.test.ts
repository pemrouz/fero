//! ── tests/links — the link sockets' own rules, on real sockets (V4-NN) ──────────────────────────────
// Two rules of shell/runtime.ts:
// - Nagle's algorithm is off on every link socket: #wire calls setNoDelay(true) before any byte can leave
//   (tests/latency.perf.ts pins what it buys: a writing method call and a forwarded update in about 1 ms, not 43);
// - the run batch (runBatch): the small frames one run of the event loop makes on a link leave together when the run
//   ends, a batch never reaches the socket's high-water mark, and no cork outlives its run; every socket the shell
//   destroys, and every socket of a process that exits, is flushed first.
//! How the checks see the sockets: a PASSIVE spy on net.Socket's prototype (setNoDelay and write, the public methods
// the shell calls; _write and _writev, the stream methods Node calls to hand bytes to the OS), installed for one test
// and taken off after. It records and calls straight through, so nothing behaves differently. (If #wire ever turns
// Nagle off another way, the `noDelay` option of net.connect or net.createServer, this spy does not see it and the
// first test goes red: point the spy at the new spelling.)

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import net from 'node:net'
import path from 'node:path'
import { fero } from '../api/index.ts'
import { snapshot } from '../api/substrate.ts'
import { Runtime } from '../shell/runtime.ts'
import { REC } from '../kernel/env.ts'
import { Framer, VERB, encodeControl } from '../kernel/codec.ts'
import { ports, until } from '#utils'
import type { Context } from '../api/methods.ts'
import type { Fero } from '../api/types.ts'

type Spy = {
  off: () => void
  written: Set<net.Socket> // every TCP socket the process wrote to
  early: string[] // a socket written to before its setNoDelay(true)
  noDelay: WeakSet<net.Socket>
  over: string[] // a write made while corked that took the batch to the high-water mark
  handed: Map<net.Socket, number> // how many times Node handed bytes to the OS (_write or _writev), per socket
}
const SPIED = ['write', 'setNoDelay', '_write', '_writev'] as const
//! spy — install the passive spy; `off` restores the prototype exactly as it was (own property or inherited)
const spy = (): Spy => {
  const proto = net.Socket.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const own = SPIED.map((k) => Object.getOwnPropertyDescriptor(proto, k))
  const orig = Object.fromEntries(SPIED.map((k) => [k, proto[k]])) as Record<(typeof SPIED)[number], (...a: unknown[]) => unknown>
  const s: Spy = { off: () => {}, written: new Set(), early: [], noDelay: new WeakSet(), over: [], handed: new Map() }
  //! TCP only: the test runner's own stdout is a pipe, a net.Socket with no remote port
  const tcp = (x: net.Socket) => typeof x.remotePort === 'number'
  proto.setNoDelay = function (this: net.Socket, ...a: unknown[]) {
    if (a[0] === false) s.noDelay.delete(this); else s.noDelay.add(this)
    return orig.setNoDelay.apply(this, a)
  }
  proto.write = function (this: net.Socket, ...a: unknown[]) {
    if (tcp(this)) {
      if (!s.written.has(this) && !s.noDelay.has(this)) s.early.push(`${this.localPort} -> ${this.remotePort}`)
      s.written.add(this)
      const len = (a[0] as Uint8Array).length
      if (this.writableCorked > 0 && this.writableLength + len >= this.writableHighWaterMark)
        s.over.push(`${this.localPort} -> ${this.remotePort}: ${this.writableLength} batched + ${len} >= ${this.writableHighWaterMark}`)
    }
    return orig.write.apply(this, a)
  }
  for (const k of ['_write', '_writev'] as const)
    proto[k] = function (this: net.Socket, ...a: unknown[]) {
      if (tcp(this)) s.handed.set(this, (s.handed.get(this) ?? 0) + 1)
      return orig[k].apply(this, a)
    }
  s.off = () => SPIED.forEach((k, i) => { const d = own[i]; if (d) Object.defineProperty(proto, k, d); else delete proto[k] })
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
    assert.deepEqual(s.over, [], 'no batch reached the high-water mark')
  } finally {
    s.off()
    for (const f of live.reverse()) await f.destroy()
  }
})

//! the run batch, on two bare Runtimes over one link (heartbeats off, so nothing else is sent): one run makes 2,000
// one-record steps, so 2,000 small frames to the peer (about 220 KB, several batches' worth), and two frames over the
// high-water mark, one first and one in the middle. Measured here: Node handed the bytes to the OS 8 times; with
// the batch taken out, 2,002 times.
test('the run batch: 2,000 small frames made in one run reach the OS in a few writes, no batch reaches the high-water mark, a big frame is never batched, and no socket is still corked once the run ends', async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const a = new Runtime({ uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeatMs: 0, redialMs: 50 })
  const b = new Runtime({ uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [], heartbeatMs: 0, redialMs: 50 })
  const s = spy()
  try {
    await a.start()
    await b.start()
    assert.ok(await until(() => a.node.admitted().length === 1 && b.node.admitted().length === 1), 'a and b linked')
    await new Promise((r) => setTimeout(r, 50)) // the link's opening exchange is over
    const toB = [...s.written].find((x) => x.remotePort === pb)!
    assert.ok(toB, 'the spy saw a\'s socket to b')
    const handed0 = s.handed.get(toB) ?? 0
    const N = 2000
    let big = 0
    //! a big frame opens the run (the socket is not corked yet: the rule that it is never corked is what holds) and
    // another lands mid-batch (the batch is flushed before it)
    const bigOne = (i: number) => { a.write([{ type: REC.update, key: [`big${i}`], value: 'y'.repeat(2 * toB.writableHighWaterMark) }]); big++ }
    bigOne(0)
    for (let i = 0; i < N; i++) {
      a.write([{ type: REC.update, key: [`k${i}`], value: { n: i, pad: 'x'.repeat(64) } }])
      if (i === N / 2) bigOne(1)
    }
    //! a tick scheduled now runs after every uncork the run scheduled (the tick queue is first in, first out)
    const corkedAfter = await new Promise<number[]>((r) => process.nextTick(() => r([...s.written].filter((x) => !x.destroyed).map((x) => x.writableCorked))))
    assert.deepEqual(corkedAfter.filter((c) => c !== 0), [], 'no socket is still corked once the run that corked it ends')
    assert.deepEqual(s.over, [], 'no batch reached the high-water mark, and the big frame was never batched')
    const handed = (s.handed.get(toB) ?? 0) - handed0
    console.log(`  ${N + big} frames in one run reached the OS in ${handed} writes`)
    assert.ok(handed > 0 && handed <= 200, `${N + big} frames reached the OS in ${handed} writes (at most 200; one write per frame is ${N + big})`)
    assert.ok(await until(() => a.node.stateHash === b.node.stateHash && b.node.state.size === a.node.state.size, 10_000), 'b holds every record')
  } finally {
    s.off()
    await a.destroy()
    await b.destroy()
  }
})

//! a raw peer the Runtime dials: it never answers, so the Runtime sends its HELLO and then only what the test ships
const rawPeer = async () => {
  const got: Buffer[] = []
  let closed = false
  const server = net.createServer((c) => { c.on('data', (d) => got.push(d)); c.on('close', () => { closed = true }); c.on('error', () => {}) })
  const port = await ports.free()
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()))
  const verbs = () => new Framer().push(new Uint8Array(Buffer.concat(got))).map((f) => f.verb)
  return { addr: `127.0.0.1:${port}`, verbs, closed: () => closed, stop: () => new Promise<void>((r) => server.close(() => r())) }
}

test('a frame shipped in the same run as its socket is closed, or as the runtime is destroyed, still reaches the peer (the batch is flushed first)', async () => {
  for (const how of ['close', 'destroy'] as const) {
    const peer = await rawPeer()
    const rt = new Runtime({ uuid: 'aa', hosts: [peer.addr], heartbeatMs: 0, redialMs: 50 })
    try {
      await rt.start()
      assert.ok(await until(() => peer.verbs().includes(VERB.HELLO)), `${how}: the HELLO arrived`)
      const [link] = rt.node.links.keys()
      //! one run: the frame is batched, then the socket goes
      rt.node.env.sink.send(link, encodeControl(VERB.PING))
      if (how === 'close') rt.node.env.sink.close(link)
      else void rt.destroy()
      assert.ok(await until(() => peer.closed()), `${how}: the peer saw the socket close`)
      assert.deepEqual(peer.verbs(), [VERB.HELLO, VERB.PING], `${how}: the PING shipped before the ${how} reached the peer`)
    } finally {
      await rt.destroy()
      await peer.stop()
    }
  }
})

test('a frame shipped in the same run as process.exit() still reaches the peer (the shell\'s exit hook flushes every batch)', async () => {
  const peer = await rawPeer()
  const child = fero.spawn(path.join(import.meta.dirname, 'links.child.ts'), [peer.addr], { stdin: 'pipe' })
  try {
    assert.ok(await until(() => child.out.includes('up') && peer.verbs().includes(VERB.HELLO), 10_000), 'the child linked and sent its HELLO')
    child.write('go')
    assert.equal(await child.exited, 0, 'the child exited 0')
    assert.ok(await until(() => peer.closed()), 'the peer saw the socket close')
    assert.deepEqual(peer.verbs(), [VERB.HELLO, VERB.PING], 'the PING shipped in the exiting run reached the peer')
  } finally {
    if (child.child.exitCode === null) child.child.kill('SIGKILL')
    await peer.stop()
  }
})
