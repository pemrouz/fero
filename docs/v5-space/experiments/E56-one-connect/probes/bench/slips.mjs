// Two slips the types of CONNECT.md cannot catch, run to see what they do (not timed).
// 1. A forgotten .get(): what printing a lens gives (E-55's lens is a Proxy over a function, with no then and no toJSON).
// 2. `{ until: req }`: when Node's HTTP request says 'close', against the response and the client. One GET on
//    loopback; the client stays 300 ms, then goes. Once with the request's body read (as a body parser does), once not.
//   node --experimental-strip-types slips.mjs
import http from 'node:http'
import { inspect } from 'node:util'
import { fero } from '../../../E55-lens-prototype/proto/lens.mjs'
import '../proto/connect.mjs'

const out = (o) => console.log(JSON.stringify({ exp: 'E-56', probe: 5, part: 'slips', node: process.version, ...o }))

{
  const shop = fero('shop', { data: { widgets: { stock: 5 } } })
  const lens = shop.data.widgets
  out({ slip: 'a forgotten .get(), printed', 'JSON.stringify(lens)': String(JSON.stringify(lens)), 'JSON.stringify({ item: lens })': JSON.stringify({ item: lens }),
    'console.log(lens)': inspect(lens), 'String(lens)': String(lens), 'Boolean(lens)': Boolean(lens) })
}

async function reqClose(readBody) {
  const t0 = Date.now(), seen = {}
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: hi\n\n')
    req.once('close', () => { seen.reqClose = Date.now() - t0; seen.reqDestroyed = req.destroyed })
    res.once('close', () => { seen.resClose = Date.now() - t0 })
    if (readBody) req.resume()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address()
  const c = http.get({ host: '127.0.0.1', port, path: '/' }, (r) => { r.on('data', () => {}) })
  c.on('error', () => {})
  await new Promise((r) => setTimeout(r, 300)); seen.clientGoes = Date.now() - t0; c.destroy()
  await new Promise((r) => setTimeout(r, 300)); srv.close()
  return seen
}
out({ slip: 'until: req, the body read', ms: await reqClose(true) })
out({ slip: 'until: req, the body not read', ms: await reqClose(false) })
process.exit(0)
