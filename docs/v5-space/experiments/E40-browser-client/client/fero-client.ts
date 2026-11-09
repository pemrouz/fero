// E-40: a prototype fero client for browsers, edge workers and Node, over one WebSocket (P-19).
// It is the smallest client that does what P-19 asks of a cold client: connect, pass the door, follow a
// resource (a snapshot, then deltas, with a cursor), and make a write that resolves when it commits. State
// lives in `data` (a keyed source folded through data's hot lane); records travel in fero v4's frame codec
// (kernel/codec.ts, which already runs in browsers: the site ships it). No Node API is used: WebSocket,
// crypto.subtle (HMAC-SHA-256 for the door), TextEncoder and performance are in every runtime it targets.
//
// Wire (binary WebSocket messages, first byte = type):
//   S->C 1 challenge  [1][32 B nonce]                      sent right after the upgrade
//   C->S 2 proof      [2][32 B HMAC(secret, nonce)][name]  the door: proves the client holds the secret
//   C->S 4 follow     [4][u32 cursor]                      sent right behind the proof (no wait)
//   C->S 6 write      [6][u32 id][fero frame]              may also ride behind the proof
//   S->C 3 welcome    [3]          or 9 refused [9][reason]
//   S->C 5 records    [5][u32 seq][fero frame]             seq 0 = the snapshot (inserts), then each commit
//   S->C 7 committed  [7][u32 id][u32 seq]                 to the writer, after the commit's records
// So the first committed write costs: TCP + TLS + the upgrade + ONE more round trip (proof, follow and write
// pipelined, then welcome, snapshot, delta and commit come back together).
import { $, lane } from '../../../../../../pemrouz/data/api/index.ts'
import { Frame, encodeFrame } from '../../../../../kernel/codec.ts'

export type Rec = { type: 0 | 1 | 2; key: string[]; value?: unknown; at?: string }
export type Marks = Record<string, number>

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b }
const cat = (...xs: Uint8Array[]) => { let n = 0; for (const x of xs) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of xs) { o.set(x, i); i += x.length } return o }
const decode = (u8: Uint8Array): Rec[] => { const rv = new Frame(u8).records(); const out = new Array(rv.length); for (let i = 0; i < rv.length; i++) out[i] = rv[i].rec(); return out }

export interface Client {
  data: any // the live view (a data proxy)
  cursor: () => number
  write: (recs: Rec[]) => Promise<number> // resolves with the commit's seq
  marks: Marks
  close: () => void
}

export function connect(url: string, opts: { name: string; secret: string; cursor?: number; firstWrite?: Rec[] }): Promise<Client> {
  const marks: Marks = { start: performance.now() }
  const origin = Symbol('fero')
  const p = $({})
  const fold = lane(p, { origin, onReject: (rj: any) => { throw rj.error } })
  let cursor = opts.cursor ?? 0, nextId = 1
  const waiting = new Map<number, (seq: number) => void>()
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const enc = new TextEncoder()
  const sendWrite = (recs: Rec[]) => { const id = nextId++; ws.send(cat(new Uint8Array([6]), u32(id), encodeFrame(recs as any))); return new Promise<number>((r) => waiting.set(id, r)) }
  return new Promise((resolve, reject) => {
    let first: Promise<number> | null = null
    const client: Client = { data: p, cursor: () => cursor, write: sendWrite, marks, close: () => ws.close() }
    ws.onopen = () => { marks.open = performance.now() }
    ws.onerror = (e) => reject(e)
    ws.onmessage = async (ev) => {
      const b = new Uint8Array(ev.data as ArrayBuffer)
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
      switch (b[0]) {
        case 1: { // challenge: answer it, follow, and (optionally) write, without waiting in between
          marks.challenge = performance.now()
          const key = await crypto.subtle.importKey('raw', enc.encode(opts.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
          const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, b.subarray(1, 33)))
          ws.send(cat(new Uint8Array([2]), mac, enc.encode(opts.name)))
          ws.send(cat(new Uint8Array([4]), u32(cursor)))
          marks.proof = performance.now()
          if (opts.firstWrite) first = sendWrite(opts.firstWrite)
          break
        }
        case 3: marks.welcome = performance.now(); if (!opts.firstWrite) resolve(client); break
        case 9: reject(new Error('refused: ' + new TextDecoder().decode(b.subarray(1)))); break
        case 5: {
          const seq = dv.getUint32(1, true)
          fold(decode(b.subarray(5)) as any)
          if (seq === 0) marks.snapshot ??= performance.now()
          if (seq > cursor) cursor = seq
          break
        }
        case 7: {
          const id = dv.getUint32(1, true), seq = dv.getUint32(5, true)
          const w = waiting.get(id); waiting.delete(id); w?.(seq)
          if (first && id === 1) { marks.committed = performance.now(); first = null; resolve(client) }
          break
        }
      }
    }
  })
}
