// E-65 X2 timing: the asking side of a scan. A connection per server process, and the scan itself.
//
//   const sc = new Scan(conns, connOf, groups, { limit, credit, enc, field, gt, cut, sequential })
//   for await (const [g, page] of sc.pages()) for (const row of page) ...   // a page at a time
//   for await (const [k, row] of sc.rows()) ...                             // a row at a time
//
// Each scan opens one session per group on the server that holds it (a cursor kept there, so pages can be
// asked ahead), and keeps at most `credit` pages per group asked or waiting here: a slow loop stops the asking.
import net from 'node:net'

export class Conn {
  constructor(port) {
    this.sock = net.connect(port, '127.0.0.1'); this.sock.setNoDelay(true)
    this.chunks = []; this.have = 0; this.need = -1; this.on = null; this.waiters = []; this.bytes = 0
    this.ready = new Promise((r) => this.sock.once('connect', r))
    this.sock.on('data', (d) => { this.chunks.push(d); this.have += d.length; this.bytes += d.length; this.drain() })
  }
  drain() { // frames: [u32 length][u32 header length][header JSON][body]
    for (;;) {
      if (this.need < 0) { if (this.have < 4) return; this.flat(); this.need = this.chunks[0].readUInt32LE(0) }
      if (this.have < 4 + this.need) return
      const b = this.flat()
      const hlen = b.readUInt32LE(4)
      const hdr = JSON.parse(b.toString('utf8', 8, 8 + hlen))
      const body = b.subarray(8 + hlen, 4 + this.need)
      const rest = b.subarray(4 + this.need)
      this.chunks = rest.length ? [rest] : []; this.have = rest.length; this.need = -1
      if (hdr.t === 'page') this.on(hdr, body); else this.waiters.shift()(hdr)
    }
  }
  flat() { if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)]; return this.chunks[0] }
  send(q) { const b = Buffer.from(JSON.stringify(q)); const p = Buffer.allocUnsafe(4); p.writeUInt32LE(b.length, 0); this.sock.write(p); this.sock.write(b) }
  ask(q) { return new Promise((r) => { this.waiters.push(r); this.send(q) }) }
  close() { this.sock.end() }
}

let scanSeq = 0
export class Scan {
  constructor(conns, connOf, groups, { limit = 1000, credit = 2, enc = 'json', field = 'n', gt, cut = false, sequential = false, check = false, id } = {}) {
    Object.assign(this, { conns, connOf, groups, limit, credit, enc, field, gt, cut, sequential, check })
    this.id = id ?? ++scanSeq
    this.looked = 0
  }
  async *pages() {
    const { id, limit, credit } = this
    const st = new Map()
    for (const g of this.groups) st.set(g, { g, inflight: 0, queued: 0, done: false, finished: false, conn: this.connOf.get(g) })
    for (const s of st.values()) s.conn.send({ t: 'open', scan: id, g: s.g, enc: this.enc, field: this.field, gt: this.gt, cut: this.cut, check: this.check })
    const q = []
    let wake = null
    const onPage = (hdr, body) => {
      const s = st.get(hdr.g)
      s.inflight--
      if (hdr.done) s.done = true
      if (s.done && s.inflight === 0) s.finished = true
      if (hdr.n > 0) { s.queued++; q.push([s, body]) }
      this.looked += hdr.looked
      if (wake) { const w = wake; wake = null; w() }
    }
    for (const c of this.conns) c.on = onPage
    const pump = () => {
      for (const s of st.values()) {
        if (s.finished) continue
        while (!s.done && s.inflight + s.queued < credit) { s.conn.send({ t: 'next', scan: id, g: s.g, limit }); s.inflight++ }
        if (this.sequential) break // one group at a time
      }
    }
    pump()
    for (;;) {
      if (!q.length) {
        let all = true; for (const s of st.values()) if (!s.finished) { all = false; break }
        if (all) break
        await new Promise((r) => (wake = r))
        pump()
        continue
      }
      const [s, body] = q.shift()
      s.queued--
      let page
      if (this.enc === 'col') { page = new Float64Array(body.length / 8); Buffer.from(page.buffer).set(body) }
      else page = JSON.parse(body.toString('utf8'))
      yield [s.g, page]
      pump()
    }
    for (const c of this.conns) c.send({ t: 'close', scan: id })
  }
  async *rows() { for await (const [, page] of this.pages()) for (const r of page) yield r }
}
