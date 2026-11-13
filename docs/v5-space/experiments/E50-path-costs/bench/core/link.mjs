// B3: what a link costs per message, per batch and per link, in Node 22, plain TCP against TLS 1.3.
//   send modes (one process holds both ends on loopback; CPU is the whole process, sender + receiver):
//     <tcp|tls>-each     one socket.write of one 150 B message per event-loop turn (a frame per op: E-27's shape)
//     <tcp|tls>-cork64   64 messages per turn, corked: one writev (v4's run batch, shell/runtime.ts:801-865)
//     <tcp|tls>-cat64    64 messages per turn copied into one buffer, one write (a frame holding a batch)
//   per link:  hs-tcp, hs-tls  (sequential connects; TLS 1.3, the P-256 ECDSA certificate E-27 made, chain verified)
//   per op:    crypto          (HMAC-SHA256 of 150 B; Ed25519 and ES256 signature checks: a token checked per write)
//   node link.mjs <mode> [n]        prints one JSON line
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import crypto from 'node:crypto'

const mode = process.argv[2] ?? 'tcp-each'
const CERTS = process.env.CERTS // a P-256 cert and key, as E-27 made them (run.sh makes them in $WORK/certs)
if (!CERTS) throw new Error('set CERTS (run.sh does this)')
const cert = fs.readFileSync(CERTS + '/cert.pem'), key = fs.readFileSync(CERTS + '/key.pem')
const MSG = 150
const cpu0 = () => ({ c: process.cpuUsage(), r: process.resourceUsage(), t: performance.now() })
const cpuEnd = (s, n) => {
  const c = process.cpuUsage(s.c), r = process.resourceUsage(), t = performance.now()
  return {
    n, wall_us_per_op: +((t - s.t) * 1e3 / n).toFixed(2),
    cpu_us_per_op: +((c.user + c.system) / n).toFixed(3), user_us_per_op: +(c.user / n).toFixed(3), sys_us_per_op: +(c.system / n).toFixed(3),
    vol_ctx_per_op: +((r.voluntaryContextSwitches - s.r.voluntaryContextSwitches) / n).toFixed(3),
  }
}
const out = (o) => console.log(JSON.stringify({ bench: 'link', mode, node: process.version, openssl: process.versions.openssl, ...o }))
const tlsSrv = { key, cert, minVersion: 'TLSv1.3' }
const tlsCli = { ca: cert, checkServerIdentity: () => undefined, minVersion: 'TLSv1.3' }

const pair = (useTls) => new Promise((ok) => {
  let serverSide
  const onConn = (s) => { serverSide = s; s.setNoDelay(true) }
  const srv = useTls ? tls.createServer(tlsSrv, onConn) : net.createServer(onConn)
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port
    const c = useTls ? tls.connect({ port, host: '127.0.0.1', ...tlsCli }) : net.connect(port, '127.0.0.1')
    c.setNoDelay(true)
    c.once(useTls ? 'secureConnect' : 'connect', () => { const w = () => (serverSide ? ok({ srv, c, s: serverSide }) : setImmediate(w)); w() })
  })
})

if (/^(tcp|tls)-(each|cork64|cat64)$/.test(mode)) {
  const [kind, how] = mode.split('-')
  const n = Number(process.argv[3] ?? (how === 'each' ? 100000 : 400000))
  const K = how === 'each' ? 1 : 64
  const { srv, c, s } = await pair(kind === 'tls')
  const msg = Buffer.alloc(MSG, 9)
  const cat = Buffer.alloc(MSG * K, 9)
  // sender = client, receiver = server side; the receiver only counts bytes (no parse: the link's own cost)
  const run = (total) => new Promise((ok) => {
    let got = 0, reads = 0, sent = 0
    const want = total * MSG
    const onData = (b) => { got += b.length; reads++; if (got >= want) { s.off('data', onData); ok(reads) } }
    s.on('data', onData)
    const pump = () => {
      let open = true
      while (open && sent < total) {
        if (how === 'each') { open = c.write(msg); sent++; break }
        if (how === 'cork64') { c.cork(); for (let k = 0; k < K; k++) open = c.write(msg); sent += K; process.nextTick(() => c.uncork()); break }
        open = c.write(cat); sent += K; break
      }
      if (sent < total) open ? setImmediate(pump) : c.once('drain', () => setImmediate(pump))
    }
    pump()
  })
  await run(Math.min(20000, n)) // warm-up
  const st = cpu0()
  const reads = await run(n)
  const r = cpuEnd(st, n)
  c.destroy(); s.destroy(); srv.close()
  out({ ...r, msg_bytes: MSG, per_turn: K, reads_per_msg: +(reads / n).toFixed(4) })
} else if (mode === 'hs-tcp' || mode === 'hs-tls') {
  const n = Number(process.argv[3] ?? 300)
  const useTls = mode === 'hs-tls'
  const srv = useTls ? tls.createServer(tlsSrv, (s) => s.on('error', () => {})) : net.createServer((s) => s.on('error', () => {}))
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const port = srv.address().port
  const one = () => new Promise((ok, no) => {
    const c = useTls ? tls.connect({ port, host: '127.0.0.1', ...tlsCli }) : net.connect(port, '127.0.0.1')
    c.once(useTls ? 'secureConnect' : 'connect', () => { c.destroy(); ok() })
    c.once('error', no)
  })
  for (let i = 0; i < 20; i++) await one()
  const st = cpu0()
  for (let i = 0; i < n; i++) await one()
  const r = cpuEnd(st, n)
  srv.close()
  out(r)
} else if (mode === 'crypto') {
  const msg = Buffer.alloc(MSG, 5)
  const hkey = crypto.randomBytes(32)
  const ed = crypto.generateKeyPairSync('ed25519')
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const edSig = crypto.sign(null, msg, ed.privateKey)
  const ecSig = crypto.sign('sha256', msg, ec.privateKey)
  const time = (fn, n) => { for (let i = 0; i < Math.min(2000, n); i++) fn(); const st = cpu0(); for (let i = 0; i < n; i++) fn(); return cpuEnd(st, n).cpu_us_per_op }
  out({
    hmac_sha256_us: time(() => crypto.createHmac('sha256', hkey).update(msg).digest(), 100000),
    ed25519_verify_us: time(() => crypto.verify(null, msg, ed.publicKey, edSig), 5000),
    es256_verify_us: time(() => crypto.verify('sha256', msg, ec.publicKey, ecSig), 5000),
    ok: crypto.verify(null, msg, ed.publicKey, edSig) && crypto.verify('sha256', msg, ec.publicKey, ecSig),
  })
} else throw new Error('unknown mode ' + mode)
