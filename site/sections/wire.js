/* sections/wire.js — §06 On the wire (id="wire"). REAL: every byte shown is a frame the house cluster sent.
   The frames come from the page's frame tap (core.js wraps sim.post: a bytesIn posted while a node sends IS that
   frame, with its simulated send and arrival times). They are taken apart with the kernel's OWN reader —
   kernel/codec.js Cursor, the file the kernel decodes with — and cross-checked against core.js decode() (the
   kernel's Frame); the crc32c is recomputed with the kernel's crcFrame.
   "The same bytes on disk" compares the frame, byte for byte, with every server's WAL rows in page.sim.stores.
   That claim is the kernel's (kernel/env.ts: "The WAL row IS the wire frame — one format"): node.ts commit() writes
   the owner's row with encodeRuns from the same log entries its links encode, and an inbound fresh RECORDS frame is
   persisted as the received bytes (node.ts: "the received bytes ARE the row"). It was checked before printing:
   12 seeds with a crash, a restart and a heal each — every live RECORDS frame (284) was a row of its writer's WAL,
   and every frame a server received (722) was a row of that server's WAL. The page re-checks it live (the status
   line) and prints what is true when it fails.
   Card 2 reads each node's per-writer logs (node.logs: what #sendDigest puts in a digest's d). After a restart, a
   heal or a join it captures THE EXCHANGE, defined by node.ts exactly: the digest each side sends in the step it
   journals `identified` for the other (digest-on-admit, from both ends), and the RECORDS a receiver sends in the
   step one of those digests lands (the missing suffix, shipped inside the digestIn step). The r=0 replies and the
   periodic digests (every heartbeat, from the lower-named side) are not part of it: what answers them re-sends
   writes made after the exchange began, so a later write is never shown as a gap fill. */
import { page, fmt, decode, VERB_NAME, onFrame, REDUCED, pair } from '../cluster.js'
import { Cursor, VT, VERB, HEADER, FLAG_PROV, FLAG_ATTEMPT, FLAG_PP, crcFrame } from '../lib/kernel/codec.js'
import { nid, stamp, rec, inspect, vt, esc } from '../ui.js'

const SEC = document.getElementById('wire')
const ROOT = SEC && SEC.querySelector('[data-variant="a"]')
if (ROOT) init(ROOT)

// kernel/codec.ts: a record's tag byte is [ vt:5 bits | hasAt:1 | type:2 ] — HAS_AT is not exported there
const HAS_AT = 4
const TYPE = ['update', 'insert', 'remove']
const VT_NAME = Object.fromEntries(Object.entries(VT).map(([k, v]) => [v, k]))
const RECORDS_SHAPED = new Set([VERB.RECORDS, VERB.WRITE, VERB.ACQ])
// the picker, in the order a write travels, then the rest (PING and PONG are heartbeats: never offered)
const ORDER = ['WRITE', 'RECORDS', 'WACK', 'WNACK', 'DIGEST', 'HELLO', 'JOIN', 'PROPOSE', 'VOTE', 'VIEW', 'PULL', 'LEAVE']
// the rare verbs: their chip carries a dot when a frame arrives after the last cluster action, until it is seen
const RARE = new Set(['WNACK', 'HELLO', 'JOIN', 'PROPOSE', 'VOTE', 'VIEW', 'PULL', 'LEAVE'])
// one plain line per verb (facts.md §4, from kernel/codec.ts and kernel/node.ts)
const SAYS = {
  WRITE: 'a write not yet stamped, on its way to the row’s owner',
  RECORDS: 'stamped records from one writer, sent live or to fill a gap',
  WACK: 'the owner’s yes, with the stamp it gave',
  WNACK: 'the owner’s no, with a reason',
  DIGEST: 'the highest counter it holds from each writer',
  HELLO: 'the first frame on every link: who I am (name, life, address)',
  JOIN: 'a new server asks a member to propose it into the view',
  PROPOSE: 'a ballot for the next view: its number and its members',
  VOTE: 'a member’s answer to a ballot',
  VIEW: 'announces a committed view, or answers a PULL',
  PULL: '“I saw a newer view number; send me that view.”',
  LEAVE: '“I am stopping on purpose; vote me out.”',
}
// what each key of a control frame's value means, where the kernel source says so (codec.ts, membership.ts,
// write.ts, node.ts); a key with no entry is shown as it is, with no gloss
const KEYS = {
  DIGEST: { d: 'the highest counter it holds from each writer', r: '1 asks for an answer; 0 is the answer', p: 'the same, counting only what is on its disk' },
  WACK: { u: 'who issued the write (name~life)', c: 'the issuer’s counter for this write', n: 'how many records', s: 'the stamp counter the owner gave', e: 'the view it was stamped in' },
  WNACK: { u: 'who issued the write', c: 'the issuer’s counter for this write', n: 'how many records', r: 'the reason', ce: 'the owner’s view' },
  HELLO: { u: 'its name', i: 'its life', l: 'its address', r: '1 means a client', n: 'the resource' },
  JOIN: { u: 'its name', i: 'its life', l: 'its address' },
  PROPOSE: { e: 'the new view’s number', m: 'its members', p: 'who proposes it' },
  VOTE: { e: 'the view voted on', g: '1 is yes, 0 is no', ce: 'the voter’s view now', h: 'the member list it voted on', ve: 'the newest view it has voted for' },
  VIEW: { e: 'the view number', m: 'its members (name, address)' },
  PULL: { e: 'the sender’s view number' },
}

const hx = (b) => b.toString(16).padStart(2, '0')
const A = (v, tier = 'runtime') => `<span data-attested="${tier}">${esc(typeof v === 'number' ? fmt(v) : v)}</span>`
// a value and its unit stay on one line: 54 B, 5.1 s, 43 ms
const U = (s) => `<span class="nw" data-attested="runtime">${esc(s)}</span>`
const B = (n) => U(`${fmt(n)} B`)
const T = (ms) => U(vt(ms))
const MS = (n) => U(`${fmt(Math.round(n))} ms`)
const same = (a, b) => { if (a === b) return true; if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true }
const uuidOf = (origin) => String(origin).split('~')[0]
// a writer's life: n02 is life 1, n02~2 life 2 (kernel/node.ts: origin = uuid~incarnation from the second life)
const lifeOf = (o) => { const s = String(o), i = s.indexOf('~'); return i < 0 ? 1 : (+s.slice(i + 1) || 1) }
const isServer = (id) => page.serverIds.includes(id)
const near = (a, b) => Math.abs(a - b) < 1e-6
const plural = (n, one, many) => `${A(n)} ${n === 1 ? one : many}`
// a counter (seq, cid, view, life) prints the way the kernel writes it, never with a thousands comma
const C = (v) => A(String(v))
const seqRun = (base, n) => n > 1 ? `#${C(base)}–#${C(base + n - 1)}` : `#${C(base)}`
// node ids carry digits (n02, c1): every one printed is the kernel's own name for a node, so it is attested
const NI = (id) => `<span data-attested="runtime">${nid(id)}</span>`
const I = (s) => `<span data-attested="runtime">${esc(s)}</span>`
const list = (ids) => ids.map(I).join(', ')
// write HTML only when it differs from what this module wrote last (never compare the browser's re-serialisation)
const setHTML = (e, html) => { if (e && e.__h !== html) { e.__h = html; e.innerHTML = html } }
// the same for a row of buttons, keeping the keyboard focus: the button that had it gets it back, by its key
function setButtons(e, html, attr) {
  if (!e || e.__h === html) return
  const a = document.activeElement
  const key = a && a !== e && e.contains(a) ? a.getAttribute(attr) : null
  setHTML(e, html)
  if (key !== null) for (const b of e.querySelectorAll(`[${attr}]`)) if (b.getAttribute(attr) === key) { b.focus({ preventScroll: true }); break }
}
const put = (e, s) => { if (e && e.textContent !== s) e.textContent = s }
const SEP = '<span class="carry-sep">·</span>'
// an object key keeps its case inside an uppercase label: it is the real key, read from the frame's bytes (so a
// writer's name used as a key, n01, is attested like any other value from the kernel)
const KC = (k) => `<span class="kc" data-attested="runtime">${esc(k)}</span>`
// a gloss that quotes a protocol value (r = 1, g = 0) is literal text, not a figure
const G = (s) => /\d/.test(s) ? `<span data-literal>${esc(s)}</span>` : esc(s)
// a view's member list as the kernel sends it: [[uuid, address], …]
const memberIds = (m) => (Array.isArray(m) ? m : []).map((x) => (Array.isArray(x) ? x[0] : x))

// ── the byte walker: the kernel's Cursor finds every field's bytes ───────────────────────────────────────────
// annotate(bytes) → { groups: [{ key, label, cls, fields: [{ key, label, a, b, shown, title, dim }] }], verb, flags,
// prov, att, recs, value, crcOk }. `dim` marks structure bytes (length prefixes, tags, counts) inside a field.
function annotate(bytes) {
  const c = new Cursor(bytes)
  const groups = []
  let g = null
  const open = (key, label, cls) => { g = { key, label, cls, fields: [] }; groups.push(g); return g }
  const add = (key, label, a, shown, title, dim = []) => { const fd = { key, label, a, b: c.pos, shown, title, dim }; g.fields.push(fd); return fd }
  const lenEnd = (a) => { const p = new Cursor(bytes, a); p.varint(); return p.pos }
  const out = { groups, verb: 0, flags: 0, prov: null, att: null, recs: null, value: undefined, crcOk: false }

  open('hdr', 'header', 'g-hdr')
  let a = c.pos
  const magic = c.u8(); add('magic', 'magic', a, '0x' + hx(magic).toUpperCase(), 'the first byte of every frame: it marks a fero frame and its wire version')
  a = c.pos
  const flags = out.flags = c.u8()
  // the flags in the card's own words. On a WRITE the triple after the header is the attempt, not a stamp
  // (kernel/codec.ts: "its provenance triple is REINTERPRETED as the ATTEMPT triple")
  const isW = bytes[2] === VERB.WRITE
  const fw = [flags & FLAG_PROV ? (isW ? 'attempt' : 'stamp') : '', flags & FLAG_ATTEMPT ? 'attempt' : '', flags & FLAG_PP ? 'predecessors' : ''].filter(Boolean)
  const ft = !flags ? 'nothing optional: the body is one value'
    : isW ? 'the three values after the header are the attempt: who issued the write, its own counter for it, and the view it was issued in. A WRITE has no stamp yet'
    : [flags & FLAG_PROV ? '1 = a stamp follows: the writer, its first counter, the view' : '', flags & FLAG_ATTEMPT ? '2 = an attempt follows: who issued the write, and its own counter for it' : 'no attempt rides with these records', flags & FLAG_PP ? '4 = each record carries its predecessor' : ''].filter(Boolean).join('; ')
  add('flags', 'flags', a, fw.length ? fw.join(' + ') : 'none', `flags ${flags}: ${ft}`)
  a = c.pos
  const verb = out.verb = c.u8(); const vname = VERB_NAME[verb] ?? String(verb)
  add('verb', 'verb', a, esc(vname), `verb ${verb} = ${vname}: ${SAYS[vname] ?? ''}`)
  a = c.pos
  const bodyLen = c.u32()
  add('len', 'body length', a, fmt(bodyLen), `four bytes, lowest first: the body after the ${HEADER}-byte header is ${bodyLen} bytes (${HEADER} + ${bodyLen} = ${bytes.length})`)
  a = c.pos
  const crc = c.u32()
  const again = crcFrame(bytes, bytes.length)
  out.crcOk = again === crc
  add('crc', 'crc32c', a, out.crcOk ? '<span class="ok">✓ matches</span>' : '<span class="bad">✕ differs</span>', `a checksum over the header and the body. Stored: 0x${crc.toString(16).padStart(8, '0')}. Recomputed in this tab with the kernel’s crcFrame: 0x${again.toString(16).padStart(8, '0')}`)

  if (RECORDS_SHAPED.has(verb)) {
    const isWrite = verb === VERB.WRITE
    if (flags & FLAG_PROV) {
      open('prov', isWrite ? 'attempt · not stamped yet' : 'stamp', isWrite ? 'g-att' : 'g-stamp')
      a = c.pos; const o = c.str()
      add('origin', isWrite ? 'issuer' : 'origin', a, esc(o), isWrite ? 'who issued this write (name~life): it has no stamp yet' : 'the writer: the owner that stamped these records. The length comes first, in three bytes, so the encoder can fill it in after the text', [[a, lenEnd(a)]])
      a = c.pos; const s = c.varint()
      add('base', isWrite ? 'its counter' : 'base seq', a, String(s), isWrite ? 'the issuer’s own counter for this write' : 'the counter of the first record; the next record has this plus one')
      a = c.pos; const e = c.varint()
      add('epoch', 'view', a, String(e), isWrite ? 'the view the attempt was issued in (a client issues in view 0)' : 'the view number the owner stamped in')
      out.prov = { origin: o, baseSeq: s, epoch: e }
      if (flags & FLAG_ATTEMPT) {
        open('att', 'attempt', 'g-att')
        a = c.pos; const iss = c.str()
        add('issuer', 'issuer', a, esc(iss), 'who issued the write these records were stamped from (name~life). It rides along to every copy', [[a, lenEnd(a)]])
        a = c.pos; const cid = c.varint()
        add('cid', 'its counter', a, String(cid), 'the issuer’s own counter for that write')
        out.att = { issuer: iss, baseCid: cid }
      }
    }
    open('count', 'records', 'g-n')
    a = c.pos; const n = c.u32()
    add('count', 'count', a, fmt(n), 'how many records follow (four bytes, lowest first)')
    out.recs = []
    for (let i = 0; i < n; i++) {
      open('r' + i, 'record', 'g-rec')
      g.i = i
      if (flags & FLAG_PP) { a = c.pos; const pp = c.varint() - 1; add('pp', 'pp', a, String(pp), 'the record’s predecessor counter (scoped replication only)') }
      a = c.pos; const tag = c.u8(); const type = tag & 3, vtt = tag >>> 3
      add('tag', 'tag', a, esc(TYPE[type] ?? String(type)), `one byte: type ${type} (${TYPE[type] ?? '?'}), value kind ${vtt} (${VT_NAME[vtt] ?? '?'})${tag & HAS_AT ? ', an at follows' : ''}`, [])
      a = c.pos; const dims = []
      { const k0 = c.pos; c.varint(); dims.push([k0, c.pos]) }
      const kn = new Cursor(bytes, a).varint(); const key = []
      for (let s = 0; s < kn; s++) { const sa = c.pos; dims.push([sa, lenEnd(sa)]); key.push(c.str()) }
      add('key', 'key', a, key.map((k) => esc(k)).join(' · '), `the key: how many parts (${kn}), then each part with its length first`, dims)
      let at
      if (tag & HAS_AT) { a = c.pos; at = c.str(); add('at', 'at', a, esc(at), 'the insert’s position key: for a new top-level row it is that row’s own key (kernel/env.ts)', [[a, lenEnd(a)]]) }
      a = c.pos
      const vdims = valueDims(bytes, a, vtt)
      const value = vtt === VT.none ? undefined : new Cursor(bytes, a).value(vtt)
      if (vtt !== VT.none) c.value(vtt)
      if (vtt !== VT.none) add('value', 'value', a, `<span class="rec">${inspect(value)}</span>`, 'the value, in the kernel’s own binary form: kinds and lengths first (dim), then the content', vdims)
      const r = { type, key }; if (at !== undefined) r.at = at; if (vtt !== VT.none) r.value = value
      out.recs.push(r)
    }
  } else {
    const glossFor = KEYS[vname] ?? {}
    open('val', 'value', 'g-val')
    a = c.pos; const t = c.u8()
    add('vt', 'kind', a, esc(VT_NAME[t] ?? String(t)), `one byte: the value’s kind (${t} = ${VT_NAME[t] ?? '?'})`, [[a, c.pos]])
    if (t === VT.obj) {
      a = c.pos; const n = c.varint()
      add('n', 'keys', a, fmt(n), 'how many keys follow', [[a, c.pos]])
      const value = {}
      for (let i = 0; i < n; i++) {
        const ka = c.pos; const ke = lenEnd(ka); const k = c.str(); const ta = c.pos; const kt = c.u8()
        const gloss = glossFor[k]
        if (kt === VT.obj) {
          // a nested object (a digest's d and p): one field per writer
          open('k:' + k, gloss ? `${KC(k)} · ${G(gloss)}` : KC(k), 'g-ent')
          const na = c.pos; const m = c.varint()
          add('head', KC(k), ka, `${fmt(m)} ${m === 1 ? 'entry' : 'entries'}`, `the key “${k}”, its kind (object) and how many entries`, [[ka, ke], [ta, ta + 1], [na, c.pos]])
          const inner = {}
          for (let j = 0; j < m; j++) {
            const ia = c.pos; const ie = lenEnd(ia); const ik = c.str(); const it = c.u8(); const iv = c.value(it)
            inner[ik] = iv
            add('e:' + ik, KC(ik), ia, `<span class="rec">${inspect(iv)}</span>`, `${ik}: ${typeof iv === 'number' ? iv : JSON.stringify(iv)}`, [[ia, ie], [ie + new TextEncoder().encode(ik).length, ie + new TextEncoder().encode(ik).length + 1]])
          }
          value[k] = inner
        } else {
          open('k:' + k, gloss ? `${KC(k)} · ${G(gloss)}` : KC(k), 'g-ent')
          const v = c.value(kt)
          value[k] = v
          add('e', KC(k), ka, `<span class="rec">${inspect(v)}</span>`, `the key “${k}”, its kind, then its value`, [[ka, ke], [ta, ta + 1], ...valueDims(bytes, ta + 1, kt)])
        }
      }
      out.value = value
    } else {
      a = c.pos; const v = c.value(t); out.value = v
      if (c.pos > a) add('v', 'value', a, `<span class="rec">${inspect(v)}</span>`, 'the value', valueDims(bytes, a, t))
    }
  }
  if (c.pos !== bytes.length) throw new Error(`walker stopped at byte ${c.pos} of ${bytes.length}`)
  return out
}
// valueDims — the structure bytes inside one encoded value (counts, kinds, string lengths), read with the kernel's Cursor
function valueDims(bytes, at, vt) {
  const out = []
  const c = new Cursor(bytes, at)
  const walk = (t) => {
    if (t === VT.obj || t === VT.arr) {
      const a = c.pos; const n = c.varint(); out.push([a, c.pos])
      for (let i = 0; i < n; i++) {
        if (t === VT.obj) { const ka = c.pos; const p = new Cursor(bytes, ka); p.varint(); out.push([ka, p.pos]); c.str() }
        const ta = c.pos; const k = c.u8(); out.push([ta, c.pos]); walk(k)
      }
    } else if (t === VT.str) { const a = c.pos; const p = new Cursor(bytes, a); p.varint(); out.push([a, p.pos]); c.str() }
    else if (t === VT.u8) { const a = c.pos; const p = new Cursor(bytes, a); p.varint(); out.push([a, p.pos]); c.bytes() }
    else c.value(t)
  }
  if (vt !== VT.none) walk(vt)
  return out
}
// does the walker agree with the kernel's own decode (core.js decode → kernel/codec.js Frame)?
function agrees(mine, kernel) {
  const j = (x) => JSON.stringify(x)
  if (mine.verb !== kernel.verb || mine.flags !== kernel.flags) return false
  if (kernel.prov) { if (!mine.prov || mine.prov.origin !== kernel.prov.origin || mine.prov.baseSeq !== kernel.prov.baseSeq || mine.prov.epoch !== kernel.prov.epoch) return false }
  if (j(mine.att) !== j(kernel.attempt)) return false
  if (kernel.recs) {
    if (!mine.recs || mine.recs.length !== kernel.recs.length) return false
    for (let i = 0; i < kernel.recs.length; i++) { const r = kernel.recs[i], m = mine.recs[i]; if (j({ type: r.type, key: r.key, at: r.at, value: r.value }) !== j({ type: m.type, key: m.key, at: m.at, value: m.value })) return false }
  } else if (j(mine.value) !== j(kernel.value)) return false
  return true
}

function init(root) {
  const $ = (id) => root.querySelector('#' + id)
  const el = {
    pick: $('wire-pick'), meta: $('wire-meta'), dump: $('wire-dump'), more: $('wire-more'), carry: $('wire-carry'), frame: $('wire-frame'),
    onwire: $('wire-onwire'), ondisk: $('wire-ondisk'), onwireK: $('wire-onwire-k'), ondiskK: $('wire-ondisk-k'),
    onwireCol: $('wire-onwire-col'), ondiskCol: $('wire-ondisk-col'), status: $('wire-status'), foot: $('wire-foot'),
    act: $('wire-act'), actNote: $('wire-act-note'), highs: $('wire-highs'), hfoot: $('wire-hfoot'), exK: $('wire-ex-k'), ex: $('wire-ex'),
  }
  // the house links' delay range, read from the running cluster's own options (core.js HOUSE.delay)
  const HOUSE_DELAY = Array.isArray(page.opts.delay) ? page.opts.delay : null

  // ── state (rebuilt on reset) ──
  let S
  const fresh = () => ({
    // the simulated time this module started counting: 0 when no RECORDS frame left before it (a fresh page or a reset)
    t0: page.now < 2000 && !page.frames.some((f) => f.verb === 'RECORDS') ? 0 : page.now,
    latest: new Map(),     // verb → the frame its chip shows
    liveRec: null,         // the latest live RECORDS frame its writer sent to a server (the RECORDS chip)
    anyRec: null,          // the latest live RECORDS frame of any route
    recs: [],              // recent RECORDS frames { f, ae, dup }
    prev: null,            // the frame the tap saw last: a duplicated frame is the same bytes, to the same node, at the same instant
    digestStep: new Map(), // node → sim.events of its latest digestIn
    digRecent: [],         // recent DIGEST frames, in the order the tap saw them (= the order they are delivered)
    dinAt: new Map(),      // node → { at, k }: how many digestIn rows it has journaled at this simulated instant
    dinFrame: new Map(),   // node → the DIGEST frame its latest digestIn row read (several can land at one instant)
    readDigs: new WeakSet(), // DIGEST frames some node's journal shows it read (one landing on a closed link is not)
    idStep: new Map(),     // 'X>Y' → sim.events of X's `identified` row for peer Y: the step X's admit digest to Y leaves in
    persists: [],          // recent WAL appends from the journal { node, batch, size, at }
    dups: [],              // recent duplicate drops from the journal { node, origin, seq, at }
    rx: [],                // recent receive-side journal rows { node, name, a, b, at }: applyInbound, frameDrop, dupLink, identified
    walDead: new Map(),    // node → simulated time its WAL failed (journal persistFail); a restart clears it
    born: new Map(),       // node → simulated time its current life began (its last restart on this page)
    faults: new Map(),     // link pair → the fault the page set on it (page.on('fault'))
    cap: null,             // the last exchange after a restart / heal / join
    tally: { live: 0, ok: 0, miss: [] }, toCheck: [],
    sel: 'RECORDS',        // the picked verb, or 'FILL' for a captured gap-fill frame
    fill: null,            // { f } — the gap-fill frame picked in card 2
    manual: false,         // the reader picked a frame by hand since the last cluster action
    follow: null,          // the vote card 1 turns to after a crash, a clean stop, a server cut off, or a return
    lastAct: 0,            // simulated time of the last cluster action (kill, restart, leave, cut, heal, join)
    seen: new Map(),       // verb → the frame last shown for it (a rare chip's dot clears once it is seen)
    shown: null, shownKey: '', shownHex: new Map(),
    verdict: '', exShips: new Map(),
  })
  S = fresh()
  // what the next animation frame redraws now (the lists, the table, the button and the status line redraw on the 250 ms slow path)
  const want = { frame: true, chips: true, ex: true, all() { this.frame = this.chips = this.ex = true } }
  const dec = new WeakMap()
  const D = (f) => { let d = dec.get(f); if (!d) { d = decode(f.bytes); dec.set(f, d) } return d }
  // frame → the link fault in force when it was sent, when it differs from the house link
  const faultAt = new WeakMap()
  const oddDelay = (fl) => !!(fl && fl.delay && HOUSE_DELAY && (fl.delay[0] !== HOUSE_DELAY[0] || fl.delay[1] !== HOUSE_DELAY[1]))
  const oddFault = (fl) => oddDelay(fl) || !!(fl && fl.dupP > 0)

  // ── the taps: bookkeeping only (cheap); drawing waits for the next animation frame while on screen ──
  const take = (f, ae) => {
    // sim/exec.ts duplicates a frame by delivering the same bytes twice from one send: two taps in a row
    const dup = !!S.prev && S.prev.bytes === f.bytes && S.prev.to === f.to && S.prev.from === f.from && near(S.prev.sentAt, f.sentAt)
    S.prev = f
    if (S.faults.size) { const fl = S.faults.get(pair(f.from, f.to)); if (oddFault(fl)) faultAt.set(f, fl) }
    const v = f.verb
    if (v === 'PING' || v === 'PONG') return
    if (dup) { if (v === 'RECORDS') S.recs.push({ f, ae, dup: true }); return }
    if (v === 'DIGEST') {
      S.digRecent.push(f); if (S.digRecent.length > 400) S.digRecent.splice(0, 200)
      if (S.cap && !S.cap.done) capDigest(f)
      // the chip shows the first live server pair's periodic digest (n01 → n02 while both are up); a new frame
      // replaces it only when its bytes differ, so the card moves when a counter moves
      const [x, y] = beatPair()
      if (f.from === x && f.to === y && (!S.latest.get('DIGEST') || !same(S.latest.get('DIGEST').bytes, f.bytes))) { if (!S.latest.get('DIGEST')) want.chips = true; S.latest.set('DIGEST', f); want.frame ||= S.sel === 'DIGEST' }
      return
    }
    if (v === 'RECORDS') {
      S.recs.push({ f, ae, dup: false }); if (S.recs.length > 240) S.recs.splice(0, 120)
      if (ae === true) { if (S.cap && !S.cap.done) capShip(f); return }
      if (ae === false) {
        S.toCheck.push(f)
        let d; try { d = D(f) } catch { return }
        if (!S.anyRec) want.chips = true
        S.anyRec = f
        if (d.prov && uuidOf(d.prov.origin) === f.from && isServer(f.to)) S.liveRec = f
        want.frame ||= S.sel === 'RECORDS'
      }
      return
    }
    if (v === 'PROPOSE' && S.follow && !S.follow.got && f.sentAt >= S.follow.at - 1e-6) {
      // the ballot the followed action leads to: members without the node (a vote out) or with it (a vote in)
      const fw = S.follow
      let val = null; try { val = D(f).value } catch {}
      const m = val ? memberIds(val.m) : []
      if (val && (fw.out ? !m.includes(fw.id) : m.includes(fw.id))) { fw.got = f; fw.e = val.e; if (!S.manual) S.sel = 'PROPOSE'; want.frame = true }
    }
    S.latest.set(v, f)
    want.frame ||= S.sel === v
    want.chips = true
  }
  page.on('frame', (f) => take(f, f.verb === 'RECORDS' ? S.digestStep.get(f.from) === page.sim.events : null))
  page.on('journal', (e) => {
    if (e.name === 'digestIn') {
      // which digest this row read: frames on one link that land at one instant are read in the order they were
      // sent (sim/exec.ts: FIFO per link, ties broken by insertion), so the k-th row here is the k-th frame
      S.digestStep.set(e.node, page.sim.events)
      const cur = S.dinAt.get(e.node), k = cur && near(cur.at, e.at) ? cur.k + 1 : 0
      S.dinAt.set(e.node, { at: e.at, k })
      const read = S.digRecent.filter((g) => g.to === e.node && near(g.recvAt, e.at))[k] ?? null
      S.dinFrame.set(e.node, read)
      if (read) S.readDigs.add(read)
    }
    else if (e.name === 'persist') { S.persists.push({ node: e.node, batch: e.a, size: e.b, at: e.at }); if (S.persists.length > 600) S.persists.splice(0, 300) }
    else if (e.name === 'dupDrop') { S.dups.push({ node: e.node, origin: e.a, seq: e.b, at: e.at }); if (S.dups.length > 800) S.dups.splice(0, 400) }
    else if (e.name === 'persistFail') S.walDead.set(e.node, e.at)
    if (e.name === 'identified') S.idStep.set(e.node + '>' + e.b, page.sim.events)
    if (e.name === 'applyInbound' || e.name === 'frameDrop' || e.name === 'dupLink' || e.name === 'identified') { S.rx.push({ node: e.node, name: e.name, a: e.a, b: e.b, at: e.at }); if (S.rx.length > 2400) S.rx.splice(0, 1200) }
  })
  page.on('tick', () => {
    // a writer's own WAL row is appended after its sends, in the same step — so check queued frames now
    if (S.toCheck.length) { for (const f of S.toCheck) checkLive(f); S.toCheck.length = 0 }
    if (S.cap && !S.cap.done) capTick()
  })
  // ── the actions: each one shows here (CONCEPT §6). A crash, a clean stop or a server cut off leads to a vote, and a
  // server coming back or joining needs one too, so card 1 turns to that vote's PROPOSE frame — unless the reader
  // picks a frame by hand. A restart, a heal or a join also starts card 2's exchange.
  page.on('kill', (id) => { S.lastAct = page.now; if (isServer(id) && canVote(id)) follow('crashed', id, true); want.chips = true })
  page.on('leave', (id) => { S.lastAct = page.now; if (isServer(id)) follow('asked to leave', id, true); want.chips = true })
  page.on('cut', ([a, b]) => {
    S.lastAct = page.now; want.chips = true
    for (const x of [a, b]) if (isServer(x) && page.alive(x) && page.isolated(x) && canVote(x) && !(S.follow && S.follow.id === x && S.follow.out && near(S.follow.at, page.now))) follow('was cut off', x, true)
  })
  page.on('restart', (id) => {
    S.lastAct = page.now; S.walDead.delete(id); S.born.set(id, page.now)
    unfollow(id)
    arm('restart', [id])
    if (isServer(id) && !page.view().members.includes(id)) follow('came back', id, false)
  })
  page.on('join', (id) => { S.lastAct = page.now; arm('join', [id]); if (isServer(id)) follow('joins', id, false) })
  page.on('heal', (p) => {
    S.lastAct = page.now
    for (const x of p) if (!page.isolated(x)) unfollow(x)
    arm('heal', p)
    // a server the others voted out while it was cut off needs a vote to come back in
    for (const x of p) if (isServer(x) && page.alive(x) && !page.isolated(x) && !page.view().members.includes(x) && !(S.follow && S.follow.id === x && !S.follow.out && near(S.follow.at, page.now))) follow('came back', x, false)
  })
  page.on('fault', ([a, b, fl]) => { S.faults.set(pair(a, b), fl) })
  page.on('reset', () => { S = fresh(); want.all() })
  // frames sent before this module subscribed (the page's ~2.5 s window): everything but RECORDS, whose kind
  // (live or a digest's answer) cannot be told after the fact
  for (const f of page.frames) if (f.verb !== 'RECORDS') take(f, null)
  for (const e of page.journal) if (e.name === 'persist') S.persists.push({ node: e.node, batch: e.a, size: e.b, at: e.at })

  function beatPair() {
    const up = page.serverIds.filter((id) => page.alive(id)).sort()
    return [up[0], up[1]]
  }

  // a vote out needs a majority of the view's members still reachable without the node (kernel/membership.ts)
  function canVote(without) {
    const m = page.view().members
    if (!m.length || !m.includes(without)) return false
    return m.filter((x) => x !== without && page.alive(x) && !page.isolated(x)).length * 2 > m.length
  }
  function follow(why, id, out) {
    const prev = S.follow && !S.follow.got ? S.follow.prev : (S.sel === 'FILL' || S.sel === 'PROPOSE' ? 'RECORDS' : S.sel)
    S.follow = { why, id, out, at: page.now, prev, got: null, e: null }
    S.manual = false
    S.sel = 'PROPOSE'; S.fill = null
    want.frame = want.chips = true
  }
  // no vote is coming after all (the node came back first, or nothing happened in time): go back to the frame before
  function unfollow(id) {
    const fw = S.follow
    if (!fw || fw.got || (id && fw.id !== id)) return
    if (!S.manual && S.sel === 'PROPOSE') { S.sel = fw.prev ?? 'RECORDS'; want.frame = want.chips = true }
    S.follow = null
  }
  const followName = (fw) => fw.out ? `the vote after ${I(fw.id)} ${fw.why}` : fw.why === 'joins' ? `the vote that lets ${I(fw.id)} join` : `the vote that lets ${I(fw.id)} back in`
  const waitLine = (fw) => fw.out
    ? (fw.why === 'asked to leave' ? `waiting for the vote: the others vote ${I(fw.id)} out on its own request` : `waiting for the vote: the others vote ${I(fw.id)} out once their redials to it give up`)
    : `waiting for the vote that lets ${I(fw.id)} in`

  // ── the live check: every live RECORDS frame should be a row of its writer's WAL, byte for byte ──
  function rowOf(wal, bytes) { for (let i = wal.length - 1; i >= 0; i--) if (same(wal[i].bytes, bytes)) return i; return -1 }
  function checkLive(f) {
    let d; try { d = D(f) } catch { return }
    if (!d.prov) return
    const st = page.sim.stores.get(uuidOf(d.prov.origin))
    S.tally.live++
    if (st && rowOf(st.wal, f.bytes) >= 0) S.tally.ok++
    else { S.tally.miss.push(f); if (S.tally.miss.length > 20) S.tally.miss.shift() }
  }

  // ── the exchange: after a restart, a heal or a join, the digests the two sides trade as their link comes up, and
  // the records those digests asked for (see the header: the admit digests, and what answered them) ──
  function arm(why, ids) {
    const now = page.now
    const c0 = S.cap
    if (c0 && !c0.done && c0.why === why && near(c0.at, now)) c0.ids.push(...ids)
    else S.cap = { why, at: now, ids: [...ids], subj: null, peers: null, life: null, role: null, links: new Map(), done: false, lastAt: now }
    const c = S.cap
    c.subj = subjectOf(c)
    c.peers = why === 'heal' ? healPeers(c) : null
    c.life = page.alive(c.subj) ? page.life(c.subj) : null
    c.role = page.role(c.subj)
    for (const p of [...c.links.keys()]) if (!relevant(c, p)) c.links.delete(p)
    if (S.sel === 'FILL') { S.sel = 'RECORDS'; S.fill = null; want.frame = true }
    want.ex = want.chips = true
  }
  // the node coming back: a restart's or a join's node; for a heal, the node in every healed pair (an isolate's
  // reconnect heals one pair per peer), and for one pair of a server and a client, the server
  function subjectOf(c) {
    if (c.why !== 'heal') return c.ids[0]
    const count = new Map(); for (const id of c.ids) count.set(id, (count.get(id) ?? 0) + 1)
    const top = Math.max(...count.values())
    const tops = [...count].filter(([, n]) => n === top).map(([id]) => id)
    return tops.find(isServer) ?? tops[0]
  }
  // a heal's exchange is only on the links that healed (a heal arrives as [a, b] pairs)
  function healPeers(c) {
    const s = new Set()
    for (let i = 0; i + 1 < c.ids.length; i += 2) { const a = c.ids[i], b = c.ids[i + 1]; if (a === c.subj) s.add(b); else if (b === c.subj) s.add(a) }
    return s
  }
  const relevant = (c, peer) => peer !== c.subj && (!c.peers || c.peers.has(peer))
  const link = (c, peer) => { let L = c.links.get(peer); if (!L) { L = { peer, digs: [], ships: [], total: 0 }; c.links.set(peer, L) } return L }
  function capDigest(f) {
    const c = S.cap
    if (f.sentAt < c.at - 1e-6) return
    const peer = f.from === c.subj ? f.to : f.to === c.subj ? f.from : null
    if (!peer || !relevant(c, peer)) return
    // digest-on-admit: sent in the step its sender identified this peer (journal `identified`, then #sendDigest);
    // in a dial race each end can admit twice, one digest per link
    if (S.idStep.get(f.from + '>' + f.to) !== page.sim.events) return
    const L = link(c, peer)
    if (L.digs.length >= 6) return
    L.digs.push({ f, admit: true, out: f.from === c.subj })
    c.lastAt = page.now; want.ex = true
  }
  // a RECORDS frame sent in the step one of the admit digests was read, by that digest's receiver, back to its sender
  function capShip(f) {
    const c = S.cap
    const peer = f.from === c.subj ? f.to : f.to === c.subj ? f.from : null
    const L = peer && c.links.get(peer); if (!L) return
    const read = S.dinFrame.get(f.from)
    const g = read && L.digs.find((x) => x.f === read && x.f.from === f.to)
    if (!g) return
    L.total++
    if (L.ships.length < 12) L.ships.push({ f, g })
    c.lastAt = page.now; want.ex = want.chips = true
  }
  function capTick() {
    const c = S.cap
    const Ls = [...c.links.values()]
    const landed = Ls.every((L) => allLanded(L))
    if ((Ls.length && landed && page.now - c.lastAt > 1200) || page.now - c.at > 9000) { c.done = true; want.ex = true }
  }
  const allLanded = (L) => L.digs.every((g) => g.f.recvAt <= page.now) && L.ships.every((s) => s.f.recvAt <= page.now)
  const lastAdmit = (L, out) => { let g = null; for (const x of L.digs) if (x.admit && x.out === out) g = x; return g }
  // does `has`'s digest show records `ask`'s digest lacks?
  const ahead = (ask, has) => { try { const a = D(ask.f).value?.d ?? {}, b = D(has.f).value?.d ?? {}; return Object.keys(b).some((o) => (b[o] ?? 0) > (a[o] ?? 0)) } catch { return false } }
  // a link whose digests drew no answer: nothing was missing, or the digest that asked was never read
  function unanswered(L) {
    const out = lastAdmit(L, true), inn = lastAdmit(L, false)
    if (!out || !inn) return ''
    for (const [ask, has] of [[out, inn], [inn, out]]) if (ahead(ask, has)) {
      const r = ask.f.to
      return S.readDigs.has(ask.f) ? `${I(r)} read ${I(ask.f.from)}’s digest, but no records came back in that step` : `${I(r)} never read ${I(ask.f.from)}’s digest: it landed on a link ${I(r)} had just closed`
    }
    return 'nothing was missing, so no records were sent'
  }
  // an answer's sender's own admit digest on that link: the latest one it sent before the answer
  const ownAdmit = (L, f) => { let g = null; for (const x of L.digs) if (x.f.from === f.from && x.f.sentAt <= f.sentAt + 1e-6) g = x; return g }

  // ── drawing ──
  let shownVariant = !root.hidden, seen = false, active = false, lastSlow = 0
  const sync = () => { active = shownVariant && seen && !document.hidden; if (active) want.all() }
  root.addEventListener('variantshow', () => { shownVariant = true; sync() })
  root.addEventListener('varianthide', () => { shownVariant = false; sync() })
  document.addEventListener('visibilitychange', sync)
  if ('IntersectionObserver' in window) new IntersectionObserver((es) => { for (const e of es) seen = e.isIntersecting; sync() }, { rootMargin: '200px' }).observe(root)
  else { seen = true; sync() }
  page.watch(root)

  const cost = { ms: 0, draws: 0, max: 0, since: performance.now() }
  onFrame((now) => {
    if (!active) return
    const t0 = performance.now()
    try { draw(now) } finally { const dt = performance.now() - t0; cost.ms += dt; cost.draws++; if (dt > cost.max) cost.max = dt }
  })
  function draw(now) {
    if (now - lastSlow > 250) {
      lastSlow = now
      if (S.follow && !S.follow.got && page.now - S.follow.at > 20000) unfollow()
      want.chips = true
      if (S.shown && !want.frame) drawMeta(S.shown)
      drawLists(); drawHighs(); drawAct(); drawStatus(); if (S.cap) want.ex = true
    }
    if (want.chips) { want.chips = false; drawChips() }
    if (want.frame) { want.frame = false; drawFrame(); drawLists() }
    if (want.ex) { want.ex = false; drawExchange() }
  }

  // the frame a slot shows
  function frameFor(sel) {
    if (sel === 'FILL') return S.fill?.f ?? null
    if (sel === 'RECORDS') return S.liveRec ?? S.anyRec
    return S.latest.get(sel) ?? null
  }

  function drawChips() {
    const have = ORDER.filter((v) => frameFor(v))
    const lead = leadShip(S.cap)
    let html = have.map((v) => {
      const f = frameFor(v)
      const fresh = RARE.has(v) && S.lastAct > 0 && f.sentAt >= S.lastAct - 1e-6 && S.seen.get(v) !== f && S.sel !== v
      return `<button type="button" class="chip${S.sel === v ? ' on' : ''}${fresh ? ' new' : ''}" data-v="${v}" aria-pressed="${S.sel === v}" title="${esc(SAYS[v] ?? '')}${fresh ? ' · a new one since the last action' : ''}">${v}</button>`
    }).join('')
    if (lead) html += `<button type="button" class="chip fill${S.sel === 'FILL' ? ' on' : ''}" data-v="FILL" aria-pressed="${S.sel === 'FILL'}" title="a RECORDS frame sent in answer to a digest, after a node came back">gap fill</button>`
    setButtons(el.pick, html, 'data-v')
  }
  el.pick.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return
    const v = b.dataset.v
    if (v === 'FILL') { const f = leadShip(S.cap); if (!f) return; S.fill = { f } }
    S.sel = v; S.manual = true; want.chips = want.frame = true
  })

  // the meta line, the bytes, and "what it carries"
  function drawFrame() {
    const f = frameFor(S.sel)
    if (!f) {
      const fw = S.follow && !S.follow.got && S.sel === 'PROPOSE' ? ` · ${waitLine(S.follow)}` : ''
      setHTML(el.meta, `<span class="wire-wait">waiting for the next ${esc(S.sel === 'FILL' ? 'gap fill' : S.sel)} frame …${fw}</span>`)
      setHTML(el.dump, ''); setHTML(el.carry, ''); S.shown = null; watchEnd()
      return
    }
    S.seen.set(S.sel, f)
    let an, ok = true, err = ''
    try { an = annotate(f.bytes); ok = agrees(an, D(f)) } catch (e) { ok = false; err = String(e && e.message || e) }
    const key = S.sel
    const prevHex = S.shownKey === key ? S.shownHex : null
    const changed = S.shown !== f
    if (S.shownKey !== key) el.dump.scrollTop = 0 // another verb: start at its header
    S.shown = f; S.shownKey = key
    drawMeta(f)
    if (!ok) {
      setHTML(el.carry, '')
      el.dump.__h = null
      el.dump.innerHTML = `<p class="wire-err">The page’s byte walker and <code>kernel/codec.ts</code> disagree on this frame${err ? ` (${esc(err)})` : ''}. That is a page bug; the bytes are left unlabelled:</p><div class="wire-raw" data-attested="runtime">${[...f.bytes].map(hx).join(' ')}</div>${END}`
      watchEnd()
      return
    }
    const hexMap = new Map()
    const flashOn = prevHex && changed && !REDUCED
    const groupHtml = an.groups.map((g) => {
      const fields = g.fields.map((fd) => {
        const hexes = []
        for (let i = fd.a; i < fd.b; i++) hexes.push(hx(f.bytes[i]))
        const id = g.key + '.' + fd.key
        const h = hexes.join(' ')
        hexMap.set(id, h)
        const flash = flashOn && prevHex.get(id) !== undefined && prevHex.get(id) !== h
        // structure bytes (lengths, kinds, counts) dim; content bytes in ink
        let bytesHtml = '', run = '', runDim = null
        for (let i = fd.a; i < fd.b; i++) {
          const d = fd.dim.some(([x, y]) => i >= x && i < y)
          if (runDim !== null && d !== runDim) { bytesHtml += runDim ? `<span class="y">${run}</span> ` : `${run} `; run = '' }
          runDim = d; run += (run ? ' ' : '') + hx(f.bytes[i])
        }
        if (run) bytesHtml += runDim ? `<span class="y">${run}</span>` : run
        const label = fd.label === 'crc32c' ? `<span data-literal>crc32c</span>` : fd.label
        return `<span class="wf${flash ? ' flash' : ''}${fd.b - fd.a > 18 ? ' long' : ''}" title="${esc(fd.title ?? '')}"><span class="wf-l">${label}</span><span class="wf-b" data-attested="runtime">${bytesHtml.trim()}</span><span class="wf-v" data-attested="runtime">${fd.shown}</span></span>`
      }).join('')
      let label = g.label
      if (g.key === 'hdr') label = `header · ${A(HEADER, 'build')} B`
      else if (g.cls === 'g-rec') {
        const st = an.prov && an.verb !== VERB.WRITE ? { epoch: an.prov.epoch, seq: an.prov.baseSeq + g.i, origin: an.prov.origin } : null
        label = `record ${C(g.i + 1)}${st ? ` · <span data-attested="runtime">${stamp(st)}</span>` : an.verb === VERB.WRITE ? ' · no stamp yet' : ''}`
      } else if (g.key === 'prov' && an.verb !== VERB.WRITE) label = 'stamp · the writer, its first counter, the view'
      return `<span class="wg ${g.cls}"><span class="wg-l">${label}</span><span class="wg-f">${fields}</span></span>`
    })
    // fixed rows, so the card keeps one height from frame to frame whatever the names' lengths: a stamped frame's
    // first row is its header and stamp; a WRITE's is its header, attempt and count; a control frame is one row
    const cut = an.groups.findIndex((g) => g.key === (an.verb === VERB.WRITE ? 'count' : 'prov'))
    const rows = RECORDS_SHAPED.has(an.verb) && cut >= 0 ? [groupHtml.slice(0, cut + 1), groupHtml.slice(cut + 1)] : [groupHtml]
    const groupsHtml = rows.filter((r) => r.length).map((r) => `<div class="wrow">${r.join('')}</div>`).join('')
    S.shownHex = hexMap
    el.dump.__h = null
    el.dump.innerHTML = groupsHtml + END
    el.dump.setAttribute('aria-label', `${an.verb === VERB.RECORDS ? 'RECORDS' : VERB_NAME[an.verb]} frame, ${f.bytes.length} bytes, field by field`)
    drawCarry(f, an)
    watchEnd()
  }
  // the dump has one height on a wide screen: when the end of the frame is below its edge, the fade and its words show.
  // An IntersectionObserver on a 1px marker after the last field tells, with no layout read in the draw loop (reading
  // scrollHeight there forced a layout and tripled the section's drawing time)
  const END = '<i class="wire-end" aria-hidden="true"></i>'
  const endIO = 'IntersectionObserver' in window ? new IntersectionObserver((es) => {
    for (const e of es) {
      const hide = e.isIntersecting
      if (el.more.hidden !== hide) el.more.hidden = hide
      // clear of the scrollbar (read here, after the browser's own layout, not in the draw loop)
      if (!hide) { const r = `${el.dump.offsetWidth - el.dump.clientWidth}px`; if (el.more.style.right !== r) el.more.style.right = r }
    }
  }, { root: el.dump }) : null
  function watchEnd() {
    if (!endIO) return
    endIO.disconnect()
    const end = el.dump.querySelector('.wire-end')
    if (end) endIO.observe(end); else el.more.hidden = true
  }
  function drawMeta(f) {
    const flight = f.recvAt - f.sentAt
    const landed = f.recvAt <= page.now
    let tag = ''
    if (S.sel === 'FILL') tag = '<span class="wire-pill">a digest’s answer</span> '
    else if (f.verb === 'PROPOSE' && S.follow) {
      const fw = S.follow
      let e = null; try { e = D(f).value?.e } catch {}
      if (fw.got && e === fw.e) tag = `<span class="wire-pill">${followName(fw)}</span> `
      else if (!fw.got) tag = '<span class="wire-pill dim">an earlier ballot</span> '
    }
    // a link the page set a fault on (02's slow-link or duplicate chip) says so here, with its own range; the house
    // range sits over "the same bytes on the wire"
    const fl = faultAt.get(f)
    const linkNote = [oddDelay(fl) ? `this link set to ${U(`${fl.delay[0]}–${fl.delay[1]} ms`)}` : '', fl && fl.dupP > 0 ? 'this link duplicates frames' : ''].filter(Boolean).join('; ')
    const html = `${tag}<b>${esc(f.verb)}</b> · ${NI(f.from)} → ${NI(f.to)} · ${B(f.bytes.length)} · sent at ${T(f.sentAt)} · ${landed ? `landed ${MS(flight)} later` : `lands in ${MS(Math.max(0, f.recvAt - page.now))}`} · <span class="wire-sim">simulated clock${linkNote ? ` (${linkNote})` : ''}</span>`
    setHTML(el.meta, html)
  }
  // c1~1 is the kernel's spelling of an issuer (write.ts: uuid~incarnation); say it in words once, beside it
  const issuerGloss = (iss) => ` <span class="wl-note nw">(${I(uuidOf(iss))}, life ${C(lifeOf(iss))})</span>`
  function drawCarry(f, an) {
    const v = an.verb, name = VERB_NAME[v]
    // while card 1 waits for a vote it shows an earlier ballot; this line says what it waits for instead
    if (S.follow && !S.follow.got && S.sel === 'PROPOSE') { setHTML(el.carry, `<span class="wire-next">${waitLine(S.follow)}</span>`); return }
    let html = ''
    if (v === VERB.RECORDS || v === VERB.ACQ) {
      const st = { epoch: an.prov.epoch, seq: an.prov.baseSeq, origin: an.prov.origin }
      html += `<span class="carry-rec"><span data-attested="runtime">${rec(an.recs[0])}</span><span data-attested="runtime">${stamp(st)}</span></span>`
      if (an.recs.length > 1) html += `${SEP}<span class="carry-more">and ${plural(an.recs.length - 1, 'more record', 'more records')}</span>`
      if (an.att) html += `${SEP}<span class="carry-line">stamped from ${I(an.att.issuer)}’s write #${C(an.att.baseCid)}${issuerGloss(an.att.issuer)}</span>`
    } else if (v === VERB.WRITE) {
      html += `<span class="carry-rec"><span data-attested="runtime">${rec(an.recs[0])}</span><span class="stamp">unstamped</span></span>`
      if (an.recs.length > 1) html += `${SEP}<span class="carry-more">and ${plural(an.recs.length - 1, 'more record', 'more records')}</span>`
      html += `${SEP}<span class="carry-line">${I(an.prov.origin)}’s write #${C(an.prov.baseSeq)}, on its way to the row’s owner${issuerGloss(an.prov.origin)}</span>`
    } else {
      html += `<span class="carry-rec"><span class="rec" data-attested="runtime">${inspect(an.value)}</span></span>`
      const x = an.value
      if (name === 'WACK' && x) html += `${SEP}<span class="carry-line">the owner’s yes: ${I(x.u)}’s write #${C(x.c)} got stamp counter #${C(x.s)} in view ${C(x.e)}</span>`
      else if (name === 'DIGEST' && x && x.d) html += `${SEP}<span class="carry-line">${I(f.from)} holds ${Object.entries(x.d).map(([o, s], k) => `${I(o)}’s ${k ? '' : 'writes '}up to #${C(s)}`).join(', ') || 'no writes yet'}${x.r === 1 ? '; it asks for an answer' : ''}</span>`
      else if (name === 'PROPOSE' && x && x.m) html += `${SEP}<span class="carry-line">${x.p !== undefined ? `${I(x.p)} proposes` : 'a ballot for'} view ${C(x.e)}: ${list(memberIds(x.m))}</span>`
      else html += `${SEP}<span class="carry-line">${esc(SAYS[name] ?? '')}</span>`
    }
    setHTML(el.carry, html)
  }

  // "the same bytes on the wire" and "on disk" (live: a copy lands 30–90 ms after it is sent)
  function drawLists() {
    const f = S.shown
    if (!f) { setHTML(el.onwire, ''); setHTML(el.ondisk, ''); return }
    let d; try { d = D(f) } catch { return }
    const v = d.name
    if (v === 'RECORDS') {
      el.onwireCol.hidden = false; el.foot.classList.remove('two')
      // the house link delay (core.js HOUSE.delay), and any link the page slowed since
      const slowed = [...S.faults].filter(([, fl]) => oddDelay(fl)).map(([k, fl]) => `${k.split('|').map(I).join(' — ')} set to ${U(`${fl.delay[0]}–${fl.delay[1]} ms`)}`)
      setHTML(el.onwireK, `the same bytes on the wire${HOUSE_DELAY ? ` <span class="wire-k-sub">· links take ${U(`${HOUSE_DELAY[0]}–${HOUSE_DELAY[1]} ms`)}, simulated${slowed.map((s) => `; ${s}`).join('')}</span>` : ''}`)
      // every RECORDS frame this page saw with exactly these bytes
      const twins = S.recs.filter((r) => same(r.f.bytes, f.bytes))
      if (!twins.some((r) => r.f === f)) twins.push({ f, ae: S.sel === 'FILL', dup: false })
      const live = twins.filter((r) => !r.ae && !r.dup), ans = twins.filter((r) => r.ae && !r.dup), dups = twins.filter((r) => r.dup)
      // one entry per route; ✓ once these bytes landed there, … while they are still crossing that link. The live
      // routes lead; the frame shown above keeps its own route in the list even when it is a digest's answer
      const mineR = twins.find((r) => r.f === f)
      const shownAns = !!live.length && !!mineR && !live.includes(mineR)
      const routes = new Map()
      for (const r of (live.length ? (shownAns ? [...live, mineR] : live) : ans)) { const k = r.f.from + '>' + r.f.to; const e = routes.get(k) ?? { from: r.f.from, to: r.f.to, n: 0, dup: 0, mine: false, flying: false }; e.n++; e.mine ||= r.f === f; e.flying ||= r.f.recvAt > page.now; routes.set(k, e) }
      for (const r of dups) { const e = routes.get(r.f.from + '>' + r.f.to); if (e) e.dup++ }
      const row = (e) => {
        const mark = e.flying ? '<span class="wl-fly" title="on its way: these bytes are still crossing this link">…</span>' : '<span class="ok" title="landed">✓</span>'
        const rep = e.dup ? ` <span class="wl-note" title="the link delivered these bytes twice: a fault set on this link duplicates frames">×${A(e.n + e.dup)}</span>`
          : e.n > 1 ? ` <span class="wl-note" title="the same bytes on this link ${e.n} times: a digest that left before an answer landed asked again">×${A(e.n)}</span>` : ''
        return `<span class="wl${e.mine ? ' this' : ''}"${e.mine ? ' title="the frame shown above"' : ''}>${NI(e.from)} → ${NI(e.to)} ${mark}${rep}</span>`
      }
      let html = `<div class="wl-flow">${[...routes.values()].slice(-6).map(row).join('')}</div>`
      const moreAns = live.length ? ans.length - (shownAns ? 1 : 0) : 0
      if (moreAns > 0) html += `<div class="wl wl-dim" title="Every heartbeat, linked servers swap digests. A digest sent before these bytes landed still lacked them, so the other side sent them again; the copy changes nothing.">and ${plural(moreAns, 'more time', 'more times')} as a digest’s answer</div>`
      setHTML(el.onwire, html)
      put(el.ondiskK, 'the same bytes on disk')
      setHTML(el.ondisk, diskRows(f, d))
    } else {
      el.onwireCol.hidden = true; el.foot.classList.add('two')
      put(el.ondiskK, 'on disk')
      setHTML(el.ondisk, v === 'WRITE'
        ? '<div class="wl">nowhere: a WRITE is not stamped yet, so no write-ahead log keeps it. The owner stamps it, sends the RECORDS frame, then writes those same bytes to its log.</div>'
        : '<div class="wl">nowhere: the write-ahead log keeps RECORDS frames only, so this frame is never written to disk.</div>')
    }
  }
  function diskRows(f, d) {
    const writer = uuidOf(d.prov.origin)
    const out = []
    for (const id of page.serverIds) {
      const st = page.sim.stores.get(id)
      const who = `${NI(id)}${id === writer ? ' <span class="wl-note">stamped it</span>' : ''}`
      const i = st ? rowOf(st.wal, f.bytes) : -1
      if (i >= 0) {
        const r = st.wal[i]
        out.push(`<div class="wl">${who} · <span class="nw">WAL entry ${A(i + 1)} <span class="ok">✓</span></span>${r.resolved ? '' : ' <span class="waiting nw" title="written to the log, but its fsync has not finished: not yet saved">saving</span>'}</div>`)
        continue
      }
      // not as one entry: say what is true
      let why
      if (page.down.has(id)) why = '<span class="broken">down ✕</span>'
      else if (page.left.has(id)) why = 'left the cluster'
      else if (S.recs.some((r) => r.f.to === id && same(r.f.bytes, f.bytes) && r.f.recvAt > page.now)) why = '<span class="wl-note">on its way</span>'
      else {
        const rows = st ? recRows(st.wal, d) : null
        const its = d.recs.length === 1 ? 'its record is' : `its ${A(d.recs.length)} records are`
        if (rows && rows.length) why = rows.length === 1 ? `${its} in <span class="nw">WAL entry ${A(rows[0] + 1)}</span>, inside another frame` : `${its} in <span class="nw">WAL entries ${rows.map((x) => A(x + 1)).join(', ')}</span>`
        else why = page.isolated(id) ? 'not on its disk · <span class="broken">cut off</span>' : 'not on its disk'
      }
      out.push(`<div class="wl wl-dim">${who} · ${why}</div>`)
    }
    const clients = page.clientIds
    if (clients.length) out.push(`<div class="wl wl-dim">${clients.map((c) => NI(c)).join(' ')} · a client: no disk</div>`)
    return `<div class="wl-grid">${out.join('')}</div>`
  }
  // recRows — which WAL entries hold this frame's records (origin, seq), when no single entry has its exact bytes
  const rowIdx = new WeakMap()
  function rowInfo(row) {
    let x = rowIdx.get(row)
    if (!x) { try { const dd = decode(row.bytes); x = dd.prov ? { origin: dd.prov.origin, base: dd.prov.baseSeq, n: dd.recs.length } : { n: 0 } } catch { x = { n: 0 } } rowIdx.set(row, x) }
    return x
  }
  function recRows(wal, d) {
    const hit = new Set()
    for (let k = 0; k < d.recs.length; k++) {
      const seq = d.prov.baseSeq + k
      let found = -1
      for (let i = wal.length - 1; i >= 0 && found < 0; i--) { const x = rowInfo(wal[i]); if (x.origin === d.prov.origin && seq >= x.base && seq < x.base + x.n) found = i }
      if (found < 0) return null
      hit.add(found)
    }
    return [...hit].sort((a, b) => a - b)
  }

  // ── card 2: what each node holds (the list its digest carries), and the last exchange ──
  function tails(id) {
    const n = page.node(id); const t = {}
    if (!n) return t
    for (const [o, es] of n.logs) if (es.length) t[o] = es[es.length - 1].seq
    return t
  }
  // the server a client follows, when it passes records on as they land (its link to the client is synced:
  // node.ts flushes "the tap-forward" to synced client links in the step a RECORDS frame lands)
  function feeder(c) {
    let p = null; try { p = page.primary(c) } catch { return null }
    const n = p && page.node(p); if (!n || n.destroyed) return null
    for (const l of n.links.values()) if (l.uuid === c && l.synced && !l.dead) return p
    return null
  }
  // the records on their way to a node: carried by a RECORDS frame that has not landed yet, to the node itself or,
  // for a client, to the server that feeds it
  function flying(id) {
    const to = new Set([id])
    if (page.role(id) === 'client') { const p = feeder(id); if (p) to.add(p) }
    const s = new Set()
    for (const r of S.recs) {
      if (r.dup || !to.has(r.f.to) || r.f.recvAt <= page.now) continue
      let d; try { d = D(r.f) } catch { continue }
      if (d.prov) for (let k = 0; k < d.recs.length; k++) s.add(d.prov.origin + '#' + (d.prov.baseSeq + k))
    }
    return s
  }
  // gap(id): the records the most advanced live node holds from each writer above this node's counter — split into
  // those on their way to it and those it lacks (no frame is bringing them: only a digest exchange will)
  function gap(id, all, origins) {
    const fly = flying(id)
    let lack = 0, soon = 0
    const mine = all.get(id)
    for (const w of origins) {
      let best = null, bv = -1
      for (const [o, t] of all) if (page.alive(o) && (t[w] ?? 0) > bv) { bv = t[w] ?? 0; best = o }
      const have = mine[w] ?? 0
      if (!best || bv <= have) continue
      const es = page.node(best).logs.get(w) ?? []
      for (let k = es.length - 1; k >= 0 && es[k].seq > have; k--) { if (fly.has(w + '#' + es[k].seq)) soon++; else lack++ }
    }
    return { lack, soon }
  }
  const cutPeers = (id) => [...page.cuts].map((k) => k.split('|')).filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a))
  function drawHighs() {
    const ids = page.ids()
    const all = new Map(ids.map((id) => [id, tails(id)]))
    const origins = [...new Set([...all.values()].flatMap((t) => Object.keys(t)))]
    // one column per writer node: its latest life that has stamped anything; earlier lives fold into a line below
    const latest = new Map()
    for (const o of origins) { const u = uuidOf(o), cur = latest.get(u); if (!cur || lifeOf(o) > lifeOf(cur)) latest.set(u, o) }
    const writers = [...latest.values()].sort((x, y) => uuidOf(x).localeCompare(uuidOf(y)))
    const earlier = origins.filter((o) => latest.get(uuidOf(o)) !== o).sort((x, y) => uuidOf(x).localeCompare(uuidOf(y)) || lifeOf(x) - lifeOf(y))
    const liveIds = ids.filter((id) => page.alive(id))
    const top = (o, among = liveIds) => Math.max(0, ...among.map((id) => all.get(id)[o] ?? 0))
    const cols = `grid-template-columns: minmax(3.4rem, auto) repeat(${writers.length}, minmax(4.4rem, auto)) minmax(0, 1fr)`
    const wTitle = (w) => lifeOf(w) > 1 ? `the highest counter each node holds from ${w}: ${uuidOf(w)} in its life ${lifeOf(w)}. A restore resumes at the clock’s ceiling saved on its disk, so no counter is ever used twice across lives (kernel/node.ts)` : `the highest counter each node holds from ${w}, the writer`
    let html = `<div class="hr hh" role="row" style="${cols}"><span role="columnheader">node</span>${writers.map((w) => `<span role="columnheader" title="${esc(wTitle(w))}">from ${I(w)}</span>`).join('')}<span role="columnheader"></span></div>`
    const lacking = [], coming = []
    for (const id of ids) {
      const t = all.get(id)
      const alive = page.alive(id)
      const { lack, soon } = alive ? gap(id, all, origins) : { lack: 0, soon: 0 }
      if (lack) lacking.push([id, lack])
      if (soon) coming.push(id)
      const bits = []
      if (page.down.has(id)) bits.push(`<span class="broken">down ✕</span> <span class="wl-note">${isServer(id) ? 'disk kept' : 'no disk'}</span>`)
      else if (page.left.has(id)) bits.push('<span class="wl-note">left</span>')
      else if (alive && page.isolated(id)) bits.push('<span class="broken">cut off</span>')
      else if (alive) { const cp = cutPeers(id); if (cp.length) bits.push(`<span class="broken">cut from ${list(cp)}</span>`) }
      if (lack) bits.push(`<span class="waiting">lacks ${plural(lack, 'record', 'records')}</span>`)
      if (!bits.length && page.role(id) === 'client') bits.push('<span class="wl-note">client</span>')
      const state = bits.join(' <span class="wl-note">·</span> ')
      const cells = writers.map((w) => {
        const s = t[w]
        if (s === undefined) return '<span class="hc none">·</span>'
        const behind = alive && lack > 0 && s < top(w)
        return `<span class="hc${behind ? ' behind' : ''}${alive ? '' : ' gone'}" data-attested="runtime">#${esc(String(s))}</span>`
      }).join('')
      const cls = page.down.has(id) ? ' is-down' : page.left.has(id) ? ' is-left' : ''
      html += `<div class="hr${cls}" role="row" style="${cols}"><span class="hn">${NI(id)}</span>${cells}<span class="hs">${state}</span></div>`
    }
    setHTML(el.highs, html)
    // under the table: the earlier lives folded into one line, and why a later life's counters start high
    let foot = ''
    if (earlier.length) {
      const heldAll = earlier.every((o) => liveIds.every((id) => (all.get(id)[o] ?? 0) === top(o)))
      foot += `<div class="hf">earlier lives · ${earlier.map((o) => `${I(o)} #${C(top(o, ids))}`).join(' · ')} · ${heldAll ? '<span class="ok">✓</span> every live node holds them' : '<span class="waiting">not every live node holds them yet</span>'}</div>`
    }
    if (writers.some((w) => lifeOf(w) > 1)) foot += '<div class="hf wl-note">a later life counts on from the clock ceiling saved on its disk, so no counter is used twice</div>'
    setHTML(el.hfoot, foot)
    const holders = liveIds.filter((id) => !lacking.some(([x]) => x === id) && !coming.includes(id))
    S.verdict = !writers.length ? '<span class="wl-note">no records yet</span>'
      : lacking.length ? `<span class="waiting">${lacking.length === 1 ? `${I(lacking[0][0])} lacks ${plural(lacking[0][1], 'record', 'records')}` : `${list(lacking.map(([x]) => x))} lack records`}</span>${holders.length ? ` that ${holders.length <= 3 ? list(holders) : 'the others'} ${holders.length === 1 ? 'holds' : 'hold'}` : ''}`
      : coming.length ? `<span class="wl-note">a write is on its way${coming.length <= 3 ? ` to ${list(coming)}` : ''}</span>`
      : '<span class="ok">✓</span> every live node holds the same counters'
  }

  function digestObj(f) {
    let d; try { d = D(f) } catch { return '' }
    return `<span class="rec" data-attested="runtime">${inspect(d.value)}</span>`
  }
  // what the receiver did with an answer, ranked: the frame that filled the gap leads
  function shipRank(f) { let d; try { d = D(f) } catch { return 8 } const k = fate(f, d).k; return k === 'written' ? 0 : k === 'held' ? 1 : k === 'never' ? 2 : k === 'flying' ? 3 : 4 }
  function exLinks(c) {
    const Ls = [...c.links.values()].filter((L) => L.digs.length || L.ships.length)
    for (const L of Ls) {
      L.best = null
      for (const s of L.ships) { const r = shipRank(s.f); if (!L.best || r < L.best.r || (r === L.best.r && s.f.sentAt < L.best.s.f.sentAt)) L.best = { s, r } }
      L.both = !!(lastAdmit(L, true) && lastAdmit(L, false))
    }
    Ls.sort((x, y) => (x.best?.r ?? 9) - (y.best?.r ?? 9) || (y.both - x.both) || (x.best?.s.f.sentAt ?? 1e15) - (y.best?.s.f.sentAt ?? 1e15) || x.peer.localeCompare(y.peer))
    return Ls
  }
  const leadShip = (c) => { if (!c) return null; const L = exLinks(c).find((x) => x.best); return L ? L.best.s.f : null }
  const shipKey = (f) => `${f.from}>${f.to}@${f.sentAt.toFixed(3)}`
  const primaryOf = (c) => { try { return page.alive(c) ? page.primary(c) : null } catch { return null } }
  function drawExchange() {
    const c = S.cap
    if (!c) {
      setHTML(el.exK, 'the last exchange')
      setButtons(el.ex, '<p class="ex-none">No node has come back in this run yet. Cut one off and heal it, or crash one and restart it: the digests it trades on the way back, and the records they ask for, show here.</p>', 'data-ship')
      return
    }
    const what = c.why === 'restart' ? `${I(c.subj)} restarted${isServer(c.subj) ? ' from its disk' : ''}${c.life ? ` · life ${C(c.life)}` : ''}`
      : c.why === 'join' ? `${I(c.subj)} joined`
      : c.peers && c.peers.size === 1 ? `the link ${I(c.subj)} — ${I([...c.peers][0])} healed` : `${I(c.subj)} reconnected`
    setHTML(el.exK, `the last exchange · ${what} · at ${T(c.at)} <span class="wire-sim">simulated</span>${c.done ? '' : ' <span class="wl-note">· listening …</span>'}`)
    const Ls = exLinks(c)
    S.exShips = new Map()
    if (!Ls.length) { setButtons(el.ex, `<p class="ex-none">${I(c.subj)} ${c.done ? 'traded no digest on the way back' : 'has not traded a digest yet: its links are still coming up'}.</p>`, 'data-ship'); return }
    const first = Ls[0]
    const rows = []
    // the first link in full: its admit digests, one each way, in the order they were sent, then what answered them.
    // With an answer, the digest it answered and its sender's own; else the latest each way (in a dial race, the link
    // that is kept)
    const ds = (first.best ? [first.best.s.g, ownAdmit(first, first.best.s.f)] : [lastAdmit(first, true), lastAdmit(first, false)]).filter(Boolean).sort((x, y) => x.f.sentAt - y.f.sentAt)
    for (const g of ds) {
      const note = !g.out ? '' : c.why === 'restart' ? (c.role === 'server' ? 'its counters, back from its WAL' : 'a client keeps no disk, so it comes back empty')
        : c.why === 'join' ? (c.role === 'server' ? 'a new server starts empty' : 'a new client starts empty') : ''
      rows.push(`<div class="ex-row"><span class="ex-who">${NI(g.f.from)} → ${NI(g.f.to)}</span><span class="ex-v">DIGEST</span><span class="ex-what">${digestObj(g.f)}${note ? ` <span class="wl-note">${note}</span>` : ''}</span></div>`)
    }
    if (first.best) {
      rows.push(shipRow(first.best.s, first, c))
      const rest = first.ships.filter((s) => s !== first.best.s)
      const more = first.total - 1
      if (more > 0) {
        const recs = rest.reduce((n, s) => { try { return n + D(s.f).recs.length } catch { return n } }, 0)
        rows.push(`<div class="ex-row ex-more"><span class="ex-what">and ${plural(more, 'more frame', 'more frames')} in this exchange${rest.length === more ? ` (${plural(recs, 'record', 'records')}): ${fates(rest.map((s) => s.f))}` : ''}</span></div>`)
      }
    } else if (allLanded(first)) {
      const quiet = quietClient(first, c)
      rows.push(`<div class="ex-row ex-more"><span class="ex-what wl-note">${quiet || unanswered(first) || 'one digest so far'}</span></div>`)
    }
    // the other links, one line each
    for (const L of Ls.slice(1)) rows.push(`<div class="ex-row ex-more"><span class="ex-what">${otherLine(L, first, c)}</span></div>`)
    setButtons(el.ex, rows.join(''), 'data-ship')
  }
  // a client answers digests only from the server it follows (node.ts: "a digest arriving on a NON-primary link goes
  // unanswered"), so a link to any other server stays one-sided
  function quietClient(L, c) {
    const cl = page.role(L.peer) === 'client' ? L.peer : page.role(c.subj) === 'client' ? c.subj : null
    if (!cl) return ''
    const srv = cl === L.peer ? c.subj : L.peer
    const p = primaryOf(cl)
    return p && p !== srv && !lastAdmit(L, cl === c.subj) ? `${I(cl)} follows ${I(p)}, so it does not answer ${I(srv)}’s digest` : ''
  }
  function shipRow(s, L, c) {
    const f = s.f
    let d; try { d = D(f) } catch { return '' }
    const key = shipKey(f); S.exShips.set(key, f)
    const on = S.sel === 'FILL' && S.fill?.f === f
    // a record newer than its sender's own digest was written after that digest left: not part of the gap
    const own = ownAdmit(L, f)
    let after = ''
    if (own) {
      let od = null; try { od = D(own.f).value?.d } catch {}
      if (od && (od[d.prov.origin] ?? 0) < d.prov.baseSeq) after = uuidOf(d.prov.origin) === f.from ? ` · stamped after ${I(f.from)}’s digest left` : ` · it reached ${I(f.from)} after ${I(f.from)}’s digest left`
    }
    return `<div class="ex-row ship${on ? ' on' : ''}"><span class="ex-who">${NI(f.from)} → ${NI(f.to)}</span><span class="ex-v"><button type="button" class="ex-open" data-ship="${esc(key)}" title="show this frame’s bytes above">RECORDS</button></span><span class="ex-what">${I(d.prov.origin)}’s ${seqRun(d.prov.baseSeq, d.recs.length)} · view ${C(d.prov.epoch)} · ${plural(d.recs.length, 'record', 'records')} · ${B(f.bytes.length)}${after} · ${fate(f, d).html}</span></div>`
  }
  function otherLine(L, first, c) {
    const peer = L.peer
    if (!L.ships.length) {
      const quiet = quietClient(L, c)
      if (quiet) return quiet
      if (!L.both) return `${NI(peer)}: one digest so far`
      if (!allLanded(L)) return `${NI(peer)} traded digests too`
      const u = unanswered(L)
      return u.startsWith('nothing') ? `${NI(peer)} traded digests too · nothing was missing` : `${NI(peer)} traded digests too · ${u}`
    }
    const froms = new Set(L.ships.map((s) => s.f.from))
    const sameAsFirst = first.ships.length === L.ships.length && L.total === first.total && L.ships.every((s, k) => same(s.f.bytes, first.ships[k].f.bytes))
    const what = sameAsFirst ? `the same ${L.total === 1 ? 'frame' : 'frames'}` : plural(L.total, 'frame', 'frames')
    const s0 = L.ships[0].f
    const who = froms.size === 1 ? `${NI(s0.from)} sent ${NI(s0.to)} ${what}` : `${NI(c.subj)} and ${NI(peer)} sent each other ${what}`
    return `${who} · ${fates(L.ships.map((s) => s.f))}`
  }
  // what the receiver did with an answer, from its own journal at the arrival instant: a WAL append of the same size
  // (then the row, byte-equal, is found — searched from the end, because a reborn node's batch numbers start again
  // at 1 while its disk keeps the old life's rows), a dupDrop for every record (it already held them), an apply with
  // no append (its WAL had failed), a frameDrop, or nothing at all (a closed link: see below)
  const fateCache = new WeakMap()
  function fate(f, d) {
    // what happened at the arrival instant never changes once that step is over: cache it then
    const hit = fateCache.get(f); if (hit) return hit
    const x = fateNow(f, d)
    if (f.recvAt < page.now && x.k !== 'flying') fateCache.set(f, x)
    return x
  }
  function fateNow(f, d) {
    const to = f.to
    if (f.recvAt > page.now) return { k: 'flying', html: '<span class="wl-note">on its way</span>' }
    if (!isServer(to)) return { k: 'client', html: `${I(to)} is a client: no disk` }
    const st = page.sim.stores.get(to)
    // copies of the same bytes landing at one instant are read in the order they were sent: only the first can be
    // the one written
    const twins = S.recs.filter((r) => !r.dup && r.f.to === to && near(r.f.recvAt, f.recvAt) && same(r.f.bytes, f.bytes)).map((r) => r.f)
    const later = twins.indexOf(f) > 0
    for (const p of later ? [] : S.persists) {
      if (p.node !== to || p.size !== f.bytes.length || !near(p.at, f.recvAt) || !st) continue
      for (let i = st.wal.length - 1; i >= 0; i--) if (st.wal[i].batch === p.batch && same(st.wal[i].bytes, f.bytes)) return { k: 'written', row: i, to, html: `written to ${I(to)}’s WAL as it landed: <span class="nw">entry ${A(i + 1)}</span> <span class="ok nw">✓ same bytes</span>` }
    }
    const seqs = d.recs.map((_, k) => d.prov.baseSeq + k)
    if (seqs.every((q) => S.dups.some((x) => x.node === to && x.origin === d.prov.origin && x.seq === q && near(x.at, f.recvAt)))) {
      // the frame that brought these records first: the receiver's journal shows when it first took one of them in
      // during its current life (applyInbound), and the frame that landed at that instant carried it. A copy that
      // landed in an earlier life does not count: a crash can lose it before its WAL entry is safe
      const born = S.born.get(to) ?? -Infinity
      let first = null
      for (const x of S.rx) if (x.node === to && x.name === 'applyInbound' && x.a === d.prov.origin && seqs.includes(x.b) && x.at >= born - 1e-6 && x.at <= f.recvAt + 1e-6 && (first === null || x.at < first)) first = x.at
      let by = null
      if (first !== null) for (const r of S.recs) {
        if (r.dup || r.f === f || r.f.to !== to || !near(r.f.recvAt, first)) continue
        let dd; try { dd = D(r.f) } catch { continue }
        if (!dd.prov || dd.prov.origin !== d.prov.origin) continue
        const lo = dd.prov.baseSeq, hi = lo + dd.recs.length - 1
        if (seqs.some((q) => q >= lo && q <= hi)) { by = r; break }
      }
      const at = by && near(by.f.recvAt, f.recvAt) ? ' at the same moment and was read first' : ' first'
      const why = !by ? '' : by.ae ? ` (an earlier answer from ${I(by.f.from)} landed${at})` : ` (a live frame from ${I(by.f.from)} landed${at})`
      return { k: 'held', to, why: !!by, html: `${I(to)} already held ${d.recs.length === 1 ? 'it' : 'them'}${why}: nothing new to write` }
    }
    const here = S.rx.filter((x) => x.node === to && near(x.at, f.recvAt))
    if (here.some((x) => x.name === 'applyInbound' && x.a === d.prov.origin && seqs.includes(x.b)))
      return { k: 'applied', to, html: S.walDead.has(to) ? `taken in, but not written: ${I(to)}’s write-ahead log failed earlier` : `taken in, not written to ${I(to)}’s disk` }
    const drop = here.find((x) => x.name === 'frameDrop')
    if (drop) return { k: 'drop', to, html: `${I(to)} dropped it: ${esc(String(drop.b ?? 'a wire fault'))}` }
    // nothing at all in its journal for this frame: node.ts ignores bytes only on a link it has closed ("raced
    // close — late chunks are safely ignored"); say why that link closed when the journal shows it
    const peerLinks = new Set(S.rx.filter((x) => x.node === to && x.name === 'identified' && x.b === f.from).map((x) => x.a))
    const race = S.rx.some((x) => x.node === to && x.name === 'dupLink' && x.at >= f.sentAt - 1e-6 && x.at <= f.recvAt + 1e-6 && (peerLinks.has(x.a) || peerLinks.has(x.b)))
    return { k: 'never', to, race, html: `${I(to)} never read it: it landed on a link ${I(to)} had just closed${race ? ' (the two had dialed each other at once, and the kernel keeps one link)' : ''}` }
  }
  // one line for several answers: the fate they all shared, or how they split
  function fates(frames) {
    const fs = frames.map((f) => { try { return fate(f, D(f)) } catch { return { k: 'none', html: '' } } })
    const ks = new Set(fs.map((x) => x.k))
    const tos = new Set(frames.map((f) => f.to))
    const many = frames.length > 1
    if (ks.size === 1 && tos.size === 1) {
      const k = fs[0].k, to = frames[0].to
      if (k === 'written') return many ? `written to ${I(to)}’s WAL as they landed: <span class="nw">entries ${fs.map((x) => A(x.row + 1)).join(', ')}</span> <span class="ok nw">✓ same bytes</span>` : fs[0].html
      if (k === 'held') return many ? `${I(to)} already held them: nothing new to write` : fs[0].html
      if (k === 'never') return `${I(to)} never read ${many ? 'them' : 'it'}: ${many ? 'they' : 'it'} landed on a link ${I(to)} had just closed${fs.some((x) => x.race) ? ' (the two had dialed each other at once, and the kernel keeps one link)' : ''}`
      if (k === 'flying') return `<span class="wl-note">on ${many ? 'their' : 'its'} way</span>`
      return fs[0].html
    }
    const n = (k) => fs.filter((x) => x.k === k).length
    return [n('written') && `${A(n('written'))} written to a WAL`, n('held') && `${A(n('held'))} already held`, n('never') && `${A(n('never'))} never read (a closed link)`, n('flying') && `${A(n('flying'))} on ${n('flying') === 1 ? 'its' : 'their'} way`, n('client') && `${A(n('client'))} to a client`].filter(Boolean).join(' · ')
  }
  el.ex.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ship]'); if (!b) return
    const f = S.exShips.get(b.dataset.ship); if (!f) return
    S.fill = { f }; S.sel = 'FILL'; S.manual = true; want.chips = want.frame = want.ex = true
    // the card's head first: the picked chip, the pill and the route are the start of what the reader asked for
    el.frame?.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' })
  })

  // ── the one action: cut a server off / heal it / restart a crashed server (the dock's verbs, on the house cluster) ──
  let act = null
  function target() {
    const up = page.serverIds.filter((id) => page.alive(id) && !page.left.has(id))
    let avoid
    try { avoid = new Set([page.owner('gadgets'), ...page.clientIds.map((c) => page.alive(c) ? page.primary(c) : null)]) } catch { avoid = new Set() }
    return [...up].reverse().find((id) => !avoid.has(id)) ?? up[up.length - 1] ?? null
  }
  function drawAct() {
    // a crashed server comes back from its disk; a crashed client cannot come back as itself (the dock says so too)
    const downS = page.serverIds.find((id) => page.down.has(id))
    const downC = page.clientIds.find((id) => page.down.has(id))
    const iso = page.ids().find((id) => page.alive(id) && page.isolated(id))
    let label, note = '', run = null
    if (downS) { label = `restart ${I(downS)} from its disk ▸`; note = `${I(downS)} is down; its disk is kept`; run = () => page.restart(downS) }
    else if (iso) { label = `heal ${I(iso)} ▸`; run = () => page.reconnect(iso) }
    else if (page.cuts.size) {
      const ks = [...page.cuts]
      if (ks.length === 1) { const [a, b] = ks[0].split('|'); label = `heal ${I(a)} — ${I(b)} ▸` } else label = 'heal the cuts ▸'
      run = () => { for (const k of [...page.cuts]) { const [a, b] = k.split('|'); page.heal(a, b) } }
    } else {
      const t = target()
      if (t) { label = `cut ${I(t)} off ▸`; run = () => page.isolate(t) }
      else label = 'cut a server off ▸'
    }
    if (!note && downC) note = `${I(downC)} is down: a client has no disk, so it cannot come back as itself`
    if (!note) note = S.verdict ?? ''
    act = run
    setHTML(el.act, label)
    el.act.disabled = !run
    setHTML(el.actNote, note)
  }
  el.act.addEventListener('click', () => { if (act) { act(); want.all() } })

  function drawStatus() {
    const t = S.tally
    const since = S.t0 < 1 ? 'since this run began' : `since ${T(S.t0)} simulated`
    let html
    if (!t.live) html = `checked in this tab, byte for byte: no live RECORDS frame yet ${since}`
    else {
      html = `checked in this tab, byte for byte: ${plural(t.live, 'live RECORDS frame', 'live RECORDS frames')} ${since} · `
      if (t.ok === t.live) html += t.live === 1 ? 'it is an entry in its writer’s WAL <span class="ok">✓</span>' : 'each is an entry in its writer’s WAL <span class="ok">✓</span>'
      else {
        const f = t.miss[t.miss.length - 1]
        html += `${A(t.ok)} ${t.ok === 1 ? 'is an entry in its' : 'are entries in their'} writer’s WAL · <span class="broken">${A(t.live - t.ok)} not ✕</span>${f ? ` <span class="wl-note">(last: ${I(f.from)} → ${I(f.to)} at ${T(f.sentAt)}, simulated)</span>` : ''}`
      }
    }
    setHTML(el.status, html)
  }

  // probe hook for tools/wire-*.mjs — read-only views of what the section tracks
  // drawNow() redraws at once (a probe that steps the cluster by hand sees each state; it changes nothing in the run)
  window.__wire = { state: () => S, annotate, frameFor, agrees: (f) => agrees(annotate(f.bytes), D(f)), fate: (f) => fate(f, D(f)), cost, leadShip: () => leadShip(S.cap), drawNow: () => { lastSlow = -Infinity; draw(performance.now()) } }
}
