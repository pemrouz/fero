// K, the TypeScript twin of k-rs: a small, pure replication kernel (events in, effects out).
// E-02's inner loop (encode, an in-memory journal, a map fold) plus Raft-lite elections, so a
// chaos sim has something real to drive. The SPEC below is the contract both twins follow;
// byte identity between them is what E-04's 1,000-seed guard checks.
//
// SPEC (every integer on the wire is an unsigned LEB128 varint unless named; f64 is 8 bytes LE;
// a str is varint(UTF-8 byte length) + UTF-8 bytes; values are f64, as data's numbers are):
//   event   TICK=1 | PROPOSE=2 reqId op:u8 key [value:f64 unless op=DEL] | RECV=3 from msg...
//   op      SET=0 INCR=1 DEL=2 NOOP=3
//   msg     REQVOTE=0x10 term lastIdx lastTerm | VOTE=0x11 term granted:u8
//           APPEND=0x12 term prevIdx prevTerm commit count {term op:u8 key [value]}*
//           APPRESP=0x13 term ok:u8 matchIdx
//   effect  SEND=0x20 to len msg | PERSIST=0x21 len rec | APPLY=0x22 idx op:u8 key [after:f64 | existed:u8]
//           REPLY=0x23 reqId status:u8 (0: idx | 1: leaderHint) | ROLE=0x24 role:u8 term leader
//   journal HARD=0x30 term votedFor | ENTRIES=0x31 fromIdx count {term op key [value]}*
//   dump    term votedFor role leader commit applied lastIdx count {key f64}* (keys in UTF-8 byte order)
//   timers  heartbeat every 2 ticks; election timeout 10 + floor(u * 10) ticks, u = xorshift32 / 2^32,
//           state seeded with imul(id, 2654435761) ^ 0x9E3779B9 (as u32), re-drawn on every reset
// E04_TRAP names a deliberate bug for the guard's sensitivity test (sort-utf16, strlen-utf16, varint-32).

const TRAP = (globalThis as any).process?.env?.E04_TRAP ?? ''
const T_SORT16 = TRAP === 'sort-utf16', T_LEN16 = TRAP === 'strlen-utf16', T_VAR32 = TRAP === 'varint-32'

export const EV = { TICK: 1, PROPOSE: 2, RECV: 3 } as const
export const OP = { SET: 0, INCR: 1, DEL: 2, NOOP: 3 } as const
export const MSG = { REQVOTE: 0x10, VOTE: 0x11, APPEND: 0x12, APPRESP: 0x13 } as const
export const EFF = { SEND: 0x20, PERSIST: 0x21, APPLY: 0x22, REPLY: 0x23, ROLE: 0x24 } as const
const REC_HARD = 0x30, REC_ENTRIES = 0x31
const MAX_BATCH = 64, HEARTBEAT = 2

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { ignoreBOM: true, fatal: false })

export class W {
  /** true for the kernel's own writers: the planted traps touch only those, never the sim's encoder */
  kernel = false
  buf = new Uint8Array(256)
  dv = new DataView(this.buf.buffer)
  len = 0
  private room(n: number) {
    if (this.len + n <= this.buf.length) return
    let c = this.buf.length * 2
    while (c < this.len + n) c *= 2
    const b = new Uint8Array(c); b.set(this.buf.subarray(0, this.len)); this.buf = b; this.dv = new DataView(b.buffer)
  }
  u8(v: number) { this.room(1); this.buf[this.len++] = v }
  varint(v: number) {
    this.room(10)
    if (T_VAR32 && this.kernel) { while (v > 127) { this.buf[this.len++] = (v & 127) | 128; v >>>= 7 } this.buf[this.len++] = v; return }
    while (v >= 128) { this.buf[this.len++] = (v % 128) | 128; v = Math.floor(v / 128) }
    this.buf[this.len++] = v
  }
  f64(v: number) { this.room(8); this.dv.setFloat64(this.len, v, true); this.len += 8 }
  bytes(b: Uint8Array) { this.room(b.length); this.buf.set(b, this.len); this.len += b.length }
  str(s: string) {
    const b = enc.encode(s)
    this.varint(T_LEN16 && this.kernel ? s.length : b.length); this.bytes(b)
  }
  take(): Uint8Array { return this.buf.slice(0, this.len) }
  reset() { this.len = 0 }
}

export class R {
  b: Uint8Array
  pos: number
  end: number
  dv: DataView | undefined
  constructor(b: Uint8Array, pos = 0, end = b.length) { this.b = b; this.pos = pos; this.end = end; this.dv = undefined }
  u8(): number { if (this.pos >= this.end) throw new Error('short'); return this.b[this.pos++] }
  varint(): number {
    let v = 0, m = 1
    for (;;) { const x = this.u8(); v += (x & 127) * m; if (x < 128) return v; m *= 128 }
  }
  f64(): number { if (this.pos + 8 > this.end) throw new Error('short'); const v = (this.dv ??= new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength)).getFloat64(this.pos, true); this.pos += 8; return v }
  str(): string { const n = this.varint(); const s = dec.decode(this.b.subarray(this.pos, this.pos + n)); this.pos += n; return s }
  /** a length-prefixed byte string, copied out (the event buffer is reused by the caller) */
  bytesCopy(): Uint8Array { const n = this.varint(); if (this.pos + n > this.end) throw new Error('short'); const b = this.b.slice(this.pos, this.pos + n); this.pos += n; return b }
  rest(): Uint8Array { const s = this.b.subarray(this.pos, this.end); this.pos = this.end; return s }
  more(): boolean { return this.pos < this.end }
}

// An entry keeps its key as the UTF-8 bytes it arrived in (so it is re-sent without re-encoding)
// and decodes the string once, when it is applied.
interface Entry { term: number; op: number; kb: Uint8Array; key: string | null; value: number }
const NOKEY = new Uint8Array(0)

const writeEntry = (w: W, e: Entry) => { w.varint(e.term); w.u8(e.op); w.varint(e.kb.length); w.bytes(e.kb); if (e.op === OP.SET || e.op === OP.INCR) w.f64(e.value) }
const readEntry = (r: R): Entry => {
  const term = r.varint(), op = r.u8(), kb = r.bytesCopy()
  const value = op === OP.SET || op === OP.INCR ? r.f64() : 0
  return { term, op, kb, key: null, value }
}
const keyOf = (e: Entry): string => (e.key ??= dec.decode(e.kb))

const utf8Cmp = (a: string, b: string): number => {
  if (T_SORT16) return a < b ? -1 : a > b ? 1 : 0
  const x = enc.encode(a), y = enc.encode(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}

export class Node {
  id: number; n: number
  term = 0; votedFor = 0; role = 0; leader = 0
  log: Entry[] = []          // log[i - 1] is index i
  commit = 0; applied = 0
  map = new Map<string, number>()
  votes = 0
  next: number[]; match: number[]
  elapsed = 0; timeout = 0; hb = 0
  rng: number
  out = new W()
  private tmp = new W()

  constructor(id: number, n: number, journal?: Uint8Array) {
    this.id = id; this.n = n
    this.out.kernel = true; this.tmp.kernel = true
    this.next = new Array(n + 1).fill(1)
    this.match = new Array(n + 1).fill(0)
    this.rng = (Math.imul(id, 2654435761 | 0) ^ 0x9e3779b9) >>> 0
    if (journal && journal.length) this.replay(journal)
    this.resetTimer()
  }

  private replay(j: Uint8Array) {
    const r = new R(j)
    while (r.more()) {
      const t = r.u8()
      if (t === REC_HARD) { this.term = r.varint(); this.votedFor = r.varint() }
      else if (t === REC_ENTRIES) {
        const from = r.varint(), count = r.varint()
        this.log.length = from - 1
        for (let i = 0; i < count; i++) this.log.push(readEntry(r))
      } else throw new Error('journal tag ' + t)
    }
  }

  private nextRand(): number {
    let x = this.rng
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    this.rng = x
    return x
  }
  private resetTimer() { this.elapsed = 0; this.timeout = 10 + Math.floor((this.nextRand() / 4294967296) * 10) }
  private last(): number { return this.log.length }
  private termAt(i: number): number { return i === 0 ? 0 : i <= this.log.length ? this.log[i - 1].term : -1 }
  private majority(): number { return (this.n >> 1) + 1 }

  // ---- effects
  private persistHard() { const w = this.tmp; w.reset(); w.u8(REC_HARD); w.varint(this.term); w.varint(this.votedFor); this.emitPersist(w) }
  private persistEntries(from: number) {
    const w = this.tmp; w.reset(); w.u8(REC_ENTRIES); w.varint(from); w.varint(this.last() - from + 1)
    for (let i = from; i <= this.last(); i++) writeEntry(w, this.log[i - 1])
    this.emitPersist(w)
  }
  private emitPersist(w: W) { this.out.u8(EFF.PERSIST); this.out.varint(w.len); this.out.bytes(w.buf.subarray(0, w.len)) }
  private send(to: number, w: W) { this.out.u8(EFF.SEND); this.out.varint(to); this.out.varint(w.len); this.out.bytes(w.buf.subarray(0, w.len)) }
  private emitRole() { this.out.u8(EFF.ROLE); this.out.u8(this.role); this.out.varint(this.term); this.out.varint(this.leader) }

  // ---- roles
  private stepDown(term: number, leader: number) {
    const changed = this.role !== 0 || this.leader !== leader || this.term !== term
    if (term > this.term) { this.term = term; this.votedFor = 0; this.persistHard() }
    this.role = 0; this.leader = leader
    if (changed) this.emitRole()
  }
  private campaign() {
    this.term++; this.role = 1; this.votedFor = this.id; this.votes = 1; this.leader = 0
    this.persistHard(); this.resetTimer(); this.emitRole()
    if (this.votes >= this.majority()) return this.becomeLeader()
    const w = this.tmp
    for (let p = 1; p <= this.n; p++) if (p !== this.id) {
      w.reset(); w.u8(MSG.REQVOTE); w.varint(this.term); w.varint(this.last()); w.varint(this.termAt(this.last())); this.send(p, w)
    }
  }
  private becomeLeader() {
    this.role = 2; this.leader = this.id
    for (let p = 1; p <= this.n; p++) { this.next[p] = this.last() + 1; this.match[p] = 0 }
    this.log.push({ term: this.term, op: OP.NOOP, kb: NOKEY, key: '', value: 0 })
    this.persistEntries(this.last())
    this.match[this.id] = this.last()
    this.emitRole()
    this.hb = 0
    this.broadcast()
    this.advance()
  }
  private broadcast() { for (let p = 1; p <= this.n; p++) if (p !== this.id) this.sendAppend(p) }
  private sendAppend(p: number) {
    const prev = this.next[p] - 1
    const hi = Math.min(this.last(), prev + MAX_BATCH)
    const w = this.tmp
    w.reset(); w.u8(MSG.APPEND); w.varint(this.term); w.varint(prev); w.varint(this.termAt(prev)); w.varint(this.commit); w.varint(hi - prev)
    for (let i = prev + 1; i <= hi; i++) writeEntry(w, this.log[i - 1])
    this.send(p, w)
  }
  private advance() {
    for (let i = this.last(); i > this.commit; i--) {
      if (this.log[i - 1].term !== this.term) break
      let c = 0
      for (let p = 1; p <= this.n; p++) if (this.match[p] >= i) c++
      if (c >= this.majority()) { this.commit = i; break }
    }
    this.apply()
  }
  private apply() {
    while (this.applied < this.commit) {
      const idx = ++this.applied
      const e = this.log[idx - 1]
      const o = this.out
      o.u8(EFF.APPLY); o.varint(idx); o.u8(e.op); o.varint(e.kb.length); o.bytes(e.kb)
      if (e.op === OP.SET) { this.map.set(keyOf(e), e.value); o.f64(e.value) }
      else if (e.op === OP.INCR) { const k = keyOf(e), v = (this.map.get(k) ?? 0) + e.value; this.map.set(k, v); o.f64(v) }
      else if (e.op === OP.DEL) { o.u8(this.map.delete(keyOf(e)) ? 1 : 0) }
    }
  }

  // ---- the one entry point: an event in, the effects out
  step(ev: Uint8Array): Uint8Array {
    this.out.reset()
    const r = new R(ev)
    const t = r.u8()
    if (t === EV.TICK) this.tick()
    else if (t === EV.PROPOSE) this.propose(r)
    else if (t === EV.RECV) this.recv(r.varint(), r)
    else throw new Error('event tag ' + t)
    return this.out.buf.subarray(0, this.out.len)
  }
  private tick() {
    if (this.role === 2) { if (++this.hb >= HEARTBEAT) { this.hb = 0; this.broadcast() } }
    else if (++this.elapsed >= this.timeout) this.campaign()
  }
  private propose(r: R) {
    const reqId = r.varint(), op = r.u8(), kb = r.bytesCopy()
    const value = op === OP.SET || op === OP.INCR ? r.f64() : 0
    const o = this.out
    if (this.role !== 2) { o.u8(EFF.REPLY); o.varint(reqId); o.u8(1); o.varint(this.leader); return }
    this.log.push({ term: this.term, op, kb, key: null, value })
    this.persistEntries(this.last())
    this.match[this.id] = this.last()
    o.u8(EFF.REPLY); o.varint(reqId); o.u8(0); o.varint(this.last())
    this.broadcast()
    this.advance()
  }
  private recv(from: number, r: R) {
    const t = r.u8(), term = r.varint()
    if (term > this.term) this.stepDown(term, t === MSG.APPEND ? from : 0)
    const w = this.tmp
    if (t === MSG.REQVOTE) {
      const lastIdx = r.varint(), lastTerm = r.varint()
      const myLast = this.termAt(this.last())
      const upToDate = lastTerm > myLast || (lastTerm === myLast && lastIdx >= this.last())
      const grant = term === this.term && (this.votedFor === 0 || this.votedFor === from) && upToDate
      if (grant) { this.votedFor = from; this.persistHard(); this.resetTimer() }
      w.reset(); w.u8(MSG.VOTE); w.varint(this.term); w.u8(grant ? 1 : 0); this.send(from, w)
    } else if (t === MSG.VOTE) {
      const granted = r.u8()
      if (this.role === 1 && term === this.term && granted) { if (++this.votes >= this.majority()) this.becomeLeader() }
    } else if (t === MSG.APPEND) {
      const prev = r.varint(), prevTerm = r.varint(), commit = r.varint(), count = r.varint()
      if (term < this.term) { w.reset(); w.u8(MSG.APPRESP); w.varint(this.term); w.u8(0); w.varint(0); this.send(from, w); return }
      if (this.role !== 0 || this.leader !== from) { this.role = 0; this.leader = from; this.emitRole() }
      this.elapsed = 0
      if (prev > this.last() || this.termAt(prev) !== prevTerm) {
        w.reset(); w.u8(MSG.APPRESP); w.varint(this.term); w.u8(0); w.varint(Math.min(this.last(), prev - 1)); this.send(from, w); return
      }
      let firstNew = 0
      for (let k = 0; k < count; k++) {
        const e = readEntry(r), idx = prev + 1 + k
        if (idx <= this.last()) {
          if (this.log[idx - 1].term === e.term) continue
          this.log.length = idx - 1
        }
        this.log.push(e)
        if (firstNew === 0) firstNew = idx
      }
      if (firstNew) this.persistEntries(firstNew)
      const match = prev + count
      if (commit > this.commit) this.commit = Math.max(this.commit, Math.min(commit, match))
      this.apply()
      w.reset(); w.u8(MSG.APPRESP); w.varint(this.term); w.u8(1); w.varint(match); this.send(from, w)
    } else if (t === MSG.APPRESP) {
      const ok = r.u8(), matchIdx = r.varint()
      if (this.role !== 2 || term !== this.term) return
      if (ok) {
        if (matchIdx > this.match[from]) this.match[from] = matchIdx
        this.next[from] = this.match[from] + 1
        this.advance()
        if (this.next[from] <= this.last()) this.sendAppend(from)
      } else {
        this.next[from] = Math.max(1, Math.min(this.next[from] - 1, matchIdx + 1))
        this.sendAppend(from)
      }
    } else throw new Error('msg tag ' + t)
  }

  dump(): Uint8Array {
    const w = new W(); w.kernel = true
    w.varint(this.term); w.varint(this.votedFor); w.u8(this.role); w.varint(this.leader)
    w.varint(this.commit); w.varint(this.applied); w.varint(this.last())
    const keys = [...this.map.keys()].sort(utf8Cmp)
    w.varint(keys.length)
    for (const k of keys) { w.str(k); w.f64(this.map.get(k)!) }
    return w.take()
  }
}

/** The kernel interface the sim drives: handles in, bytes in, bytes out. */
export const tsKernel = () => {
  let nodes: (Node | null)[] = [null]
  return {
    name: 'ts',
    reset() { nodes = [null] },
    create(id: number, n: number, journal: Uint8Array): number { nodes.push(new Node(id, n, journal)); return nodes.length - 1 },
    step(h: number, ev: Uint8Array): Uint8Array { return nodes[h]!.step(ev) },
    dump(h: number): Uint8Array { return nodes[h]!.dump() },
    destroy(h: number) { nodes[h] = null },
  }
}
