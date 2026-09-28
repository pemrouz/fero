import assert from 'node:assert'
import { rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { fero, type Spawned } from '../../api/index.ts'
import { until } from '../lib.ts'

// a free port for the bridge, and the last line a role printed
const free = (s = createServer().listen(0), { port } = s.address() as AddressInfo) => (s.close(), port)
const last = (r: Spawned) => r.out.trimEnd().split('\n').pop() ?? ''

// the server, then the bridge on a free port: it follows the inventory and serves it over http
rmSync('./inventory', { recursive: true, force: true })
const port = free(), server = fero.spawn('server.ts'), web = fero.spawn('web.ts', [String(port)])
const url = `http://localhost:${port}`, json = async (path: string, body?: string) => (await fetch(url + path, body ? { method: 'POST', body } : {})).json()
assert.ok(await until(async () => web.out.includes(`WEB ${web.pid} on ${url}`) && (await json('/snapshot')).total === 11, 15_000), 'the bridge is up and follows the inventory: the seed, total 11 (is this example open in another terminal?)')

// a tab, as the page opens one: the whole object and the total first, then one record per change
const tab = { ctl: new AbortController(), text: '' }
void fetch(url + '/events', { signal: tab.ctl.signal }).then(async (r) => { for await (const c of r.body!.pipeThrough(new TextDecoderStream())) tab.text += c }).catch(() => {})
assert.ok(await until(() => tab.text.startsWith('data: {"type":"update","key":[],"value":{"widgets"') && tab.text.includes('event: total\ndata: 11') && last(web) === 'tab open 1'), 'the tab opened with the whole object and the total, and the bridge counted it')
assert.deepEqual(await json('/set', '{"key":"widgets","stock":7}'), { ok: true }, 'the post was taken')
assert.ok(await until(() => tab.text.includes('data: {"type":"update","key":["widgets"],"value":{"stock":7,"price":4}}') && tab.text.includes('event: total\ndata: 10'), 5000), 'the whole-row record and the new total reached the tab within 5 s: stock 7, the price kept')
assert.deepEqual(await json('/snapshot'), { rows: { widgets: { stock: 7, price: 4 }, gadgets: { stock: 3, price: 9 } }, total: 10 }, "the snapshot agrees: the server's echo, not a copy")

// close the tab: the bridge counts it down; restart the server: its rows come back, the seed does not
tab.ctl.abort()
assert.ok(await until(() => last(web) === 'tab closed 0'), 'the bridge saw the tab close and counted it down')
assert.equal(await server.stop(), 0, 'the server stopped cleanly')
const next = fero.spawn('server.ts')
assert.ok(await until(() => next.out.includes('widgets: { stock: 7, price: 4 }'), 15_000), 'its next life holds stock 7: dir replayed the row, the seed applied once')
for (const r of [web, next]) assert.equal(await r.stop(), 0, 'stopped cleanly on Ctrl-C')
rmSync('./inventory', { recursive: true, force: true })
console.log('ok 42-web-bridge')
