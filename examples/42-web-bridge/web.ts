import http from 'node:http'
import { fero } from '../../api/index.ts'

// the bridge is a fero client; a browser is not a fero node, so it reads a stream and posts a form here
const port = process.argv[2] ?? 8080
const f = await fero('inventory')
const total = f.data.sum('stock')
let tabs = 0

const page = `<!doctype html><title>inventory</title><h1>inventory <small id=t></small></h1><ul id=l></ul>
<form id=s>set <input name=key value=widgets> stock <input name=stock value=7 size=3> <button>go</button></form>
<script>
const rows = {}, es = new EventSource('/events')
es.onmessage = ({ data }) => {
    // the whole object first; then a row added (at), rewritten, or removed
    const { type, key, value, at } = JSON.parse(data), k = key[0] ?? at
    k === undefined ? Object.assign(rows, value) : type === 'remove' ? delete rows[k] : rows[k] = value
    l.innerHTML = Object.entries(rows).map(([k, v]) => '<li>' + k + ' ' + JSON.stringify(v)).join('')
}
es.addEventListener('total', ({ data }) => t.textContent = 'total ' + data)
s.onsubmit = (e) => {
    e.preventDefault()
    fetch('/set', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(s))) })
}
</script>`

http.createServer(async (req, res) => {
    if (req.url === '/snapshot') return res.end(JSON.stringify({ rows: f.snapshot, total: total.snapshot() }))
    if (req.url === '/events') {
        // a tab subscribes twice, the rows and the total: the whole object first, then one record per change
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        const h = f.data.connect({}, (rec) => res.write(`data: ${JSON.stringify(rec)}\n\n`))
        const n = total.connect({}, (rec) => res.write(`event: total\ndata: ${rec.value}\n\n`))
        console.log('tab open', ++tabs)
        return req.on('close', () => {
            h.dispose()
            n.dispose()
            console.log('tab closed', --tabs)
        })
    }
    if (req.method === 'POST' && req.url === '/set') {
        // the form's post becomes a whole-row write: the row's other fields kept, stock replaced
        let body = ''
        for await (const c of req) body += c
        const { key, stock } = JSON.parse(body)
        f.data[key] = { ...f.snapshot[key], stock: Number(stock) }
        console.log('set', key, stock)
        return res.end('{"ok":true}')
    }
    res.end(page)
}).listen(port, () => console.log(`WEB ${process.pid} on http://localhost:${port}`))
