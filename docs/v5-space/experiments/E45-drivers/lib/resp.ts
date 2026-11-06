// resp — a RESP2 front over one fero resource (default `kv`), so redis-benchmark and memtier can
// drive fero (PERF-02). L5: built only from fero() and the verbs.
//
//   GET k        → get(k)                 a held-row read at the gateway (it is a server: it folds kv);
//                                          --get fresh makes it get(k, { fresh: true })
//   SET k v      → set(k, v)              answers +OK after commit at the resource's durability
//   INCR k       → set(k, op.incr(1))     answers the new count (Ack.value)
//   INCRBY k n, DECR, DECRBY, DEL, EXISTS, MGET (one partition each), PING, ECHO, SELECT 0, QUIT,
//   CONFIG GET (save, appendonly: what redis-benchmark asks at start), COMMAND (empty), HELLO 2
//
// Values: a string that is a canonical integer is kept as a number, so INCR on it works and GET
// prints it back unchanged (Redis keeps such strings as integers too). Every other value is a
// string row. Replies leave in request order; a command waits for the previous one on the same
// key from the same connection, so a pipelined SET k then GET k answers as Redis does.

import net from 'node:net'
import { op } from '../../E22-api-prototype/proto/index.ts'
import { type GatewayEnv, InOrder, KeyChains, codeOf } from './common.ts'

export const resources = (o: Record<string, string>): [string, Record<string, unknown>][] =>
  [[o.resource ?? 'kv', o.durability === 'none' ? { rows: false, durability: 'none' } : {}]]

const INT = /^(0|-?[1-9][0-9]{0,14})$/
const toRow = (b: Buffer): string | number => { const s = b.toString('latin1'); return INT.test(s) ? Number(s) : s }
const bulk = (v: unknown): string => {
  if (v === undefined || v === null) return '$-1\r\n'
  const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v)
  return `$${Buffer.byteLength(s, 'latin1')}\r\n${s}\r\n`
}
const errReply = (code: string, msg = ''): string => `-ERR fero ${code}${msg ? ' ' + msg : ''}\r\n`

/** parse as many complete commands as `buf` holds; returns them and the bytes left over */
export const parse = (buf: Buffer): { cmds: Buffer[][]; rest: Buffer } => {
  const cmds: Buffer[][] = []
  let i = 0
  const line = (from: number): number => { const j = buf.indexOf('\r\n', from, 'latin1'); return j }
  while (i < buf.length) {
    if (buf[i] === 0x2a /* * */) {
      const e = line(i)
      if (e < 0) break
      const n = Number(buf.toString('latin1', i + 1, e))
      let j = e + 2
      const args: Buffer[] = []
      let ok = true
      for (let a = 0; a < n; a++) {
        if (j >= buf.length) { ok = false; break }
        if (buf[j] !== 0x24 /* $ */) throw new Error('protocol: expected $')
        const e2 = line(j)
        if (e2 < 0) { ok = false; break }
        const len = Number(buf.toString('latin1', j + 1, e2))
        if (e2 + 2 + len + 2 > buf.length) { ok = false; break }
        args.push(buf.subarray(e2 + 2, e2 + 2 + len))
        j = e2 + 2 + len + 2
      }
      if (!ok) break
      cmds.push(args)
      i = j
    } else {
      // an inline command (PING_INLINE, a telnet user)
      const e = line(i)
      if (e < 0) break
      const parts = buf.toString('latin1', i, e).trim().split(/\s+/).filter(Boolean).map((s) => Buffer.from(s, 'latin1'))
      if (parts.length > 0) cmds.push(parts)
      i = e + 2
    }
  }
  return { cmds, rest: buf.subarray(i) }
}

export const start = async (env: GatewayEnv): Promise<{ close(): Promise<void>; port: number }> => {
  const name = env.opts.resource ?? 'kv'
  const kv = await env.fero(name)
  const fresh = env.opts.get === 'fresh'
  const { stats } = env
  const exec = (args: Buffer[], reply: (s: string) => void, chains: KeyChains, close: () => void): void => {
    const cmd = args[0].toString('latin1').toUpperCase()
    const key = args[1]?.toString('latin1')
    stats.op(cmd)
    const fail = (e: unknown): void => { const c = codeOf(e); stats.err(c); reply(errReply(c, (e as any)?.reason ?? '')) }
    const onKey = (fn: () => Promise<string>): void => {
      if (key === undefined || key === '') { stats.err('arity'); reply(`-ERR wrong number of arguments for '${cmd.toLowerCase()}' command\r\n`); return }
      chains.run(key, () => env.run(fn)).then(reply, fail)
    }
    const incrBy = (n: number): void => onKey(async () => {
      const a = await kv.set(key!, op.incr(n))
      return `:${a.value}\r\n`
    })
    switch (cmd) {
      case 'GET': onKey(async () => bulk(await kv.get(key!, fresh ? { fresh: true } : {}))); return
      case 'SET': {
        if (args.length < 3) { reply(`-ERR wrong number of arguments for 'set' command\r\n`); return }
        if (args.length > 3) { stats.err('set-options'); reply(errReply('unsupported', 'SET options (EX, NX, ...) are not mapped yet')); return }
        const v = toRow(args[2])
        onKey(async () => { await kv.set(key!, v); return '+OK\r\n' })
        return
      }
      case 'INCR': incrBy(1); return
      case 'DECR': incrBy(-1); return
      case 'INCRBY': incrBy(Number(args[2]?.toString('latin1'))); return
      case 'DECRBY': incrBy(-Number(args[2]?.toString('latin1'))); return
      case 'DEL': onKey(async () => { await kv.remove(key!); return ':1\r\n' })  // fero's remove does not say whether the row existed
        return
      case 'EXISTS': onKey(async () => `:${(await kv.get(key!, fresh ? { fresh: true } : {})) === undefined ? 0 : 1}\r\n`); return
      case 'MGET': {
        const keys = args.slice(1).map((b) => b.toString('latin1'))
        Promise.all(keys.map((k) => chains.run(k, () => env.run(() => kv.get(k)))))
          .then((vs) => reply(`*${vs.length}\r\n` + vs.map(bulk).join('')), fail)
        return
      }
      case 'PING': reply(args.length > 1 ? bulk(args[1].toString('latin1')) : '+PONG\r\n'); return
      case 'ECHO': reply(bulk(args[1]?.toString('latin1') ?? '')); return
      case 'SELECT': reply(args[1]?.toString('latin1') === '0' ? '+OK\r\n' : '-ERR fero has one keyspace per resource\r\n'); return
      case 'QUIT': reply('+OK\r\n'); close(); return
      case 'CONFIG': {
        const sub = args[1]?.toString('latin1').toUpperCase()
        const what = args[2]?.toString('latin1') ?? ''
        if (sub !== 'GET') { reply('-ERR fero: only CONFIG GET\r\n'); return }
        const persisted = env.opts.durability !== 'none'
        const known: Record<string, string> = { save: '', appendonly: persisted ? 'yes' : 'no', appendfsync: persisted ? 'always' : 'no' }
        const v = known[what]
        reply(v === undefined ? '*0\r\n' : `*2\r\n${bulk(what)}${bulk(v)}`)
        return
      }
      case 'COMMAND': reply('*0\r\n'); return
      case 'INFO': reply(bulk('# Server\r\nredis_version:7.0.15\r\nredis_mode:standalone\r\n# fero-e45-gateway\r\n')); return
      case 'HELLO': reply(args[1] && args[1].toString() !== '2' ? '-NOPROTO fero speaks RESP2 only\r\n' : `*2\r\n${bulk('server')}${bulk('fero-gateway')}`); return
      case 'CLIENT': reply('+OK\r\n'); return
      default: stats.err('unknown-command'); reply(`-ERR unknown command '${cmd.toLowerCase()}'\r\n`)
    }
  }
  const server = net.createServer((sock) => {
    stats.conns++
    sock.setNoDelay(true)
    let buf: Buffer = Buffer.alloc(0)
    const order = new InOrder((b) => { stats.bytesOut += b.length; sock.write(b) })
    const chains = new KeyChains()
    sock.on('data', (d: Buffer) => {
      stats.bytesIn += d.length
      buf = buf.length === 0 ? d : Buffer.concat([buf, d])
      let r
      try { r = parse(buf) } catch (e) { sock.end(`-ERR ${(e as Error).message}\r\n`); return }
      buf = Buffer.from(r.rest)
      for (const args of r.cmds) exec(args, order.slot(), chains, () => sock.end())
    })
    sock.on('error', () => {})
    sock.on('close', () => { stats.conns-- })
  })
  const [host, port] = (env.opts.listen ?? '127.0.0.1:16390').split(':')
  await new Promise<void>((r) => server.listen(Number(port), host, r))
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) }
}
