// kafka-codec — encode and decode Kafka protocol messages from Kafka's own message specs (the JSON
// files inside kafka-clients-<v>.jar, common/message/*.json; fetch.sh extracts them). One generic
// reader and writer covers every version a spec declares, flexible versions (compact strings and
// arrays, tagged fields) included, so the gateway can answer at whatever version the client picks.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Field = { name: string; type: string; versions: string; nullableVersions?: string; taggedVersions?: string; tag?: number; default?: unknown; fields?: Field[]; ignorable?: boolean }
export interface Spec { name: string; apiKey?: number; type: string; validVersions: string; flexibleVersions: string; fields: Field[]; commonStructs?: { name: string; fields: Field[] }[] }

export const loadSpec = (dir: string, name: string): Spec => {
  const t = readFileSync(join(dir, name + '.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(t)
}
const inRange = (r: string | undefined, v: number): boolean => {
  if (!r || r === 'none') return false
  if (r.endsWith('+')) return v >= Number(r.slice(0, -1))
  const [a, b] = r.split('-').map(Number)
  return b === undefined ? v === a : v >= a && v <= b
}
export const range = (r: string): [number, number] => {
  if (r.endsWith('+')) return [Number(r.slice(0, -1)), 32767]
  const [a, b] = r.split('-').map(Number)
  return [a, b ?? a]
}

// ── bytes ──────────────────────────────────────────────────────────────────
export class Reader {
  b: Buffer; o: number
  constructor(b: Buffer, o = 0) { this.b = b; this.o = o }
  i8(): number { return this.b.readInt8(this.o++) }
  i16(): number { const v = this.b.readInt16BE(this.o); this.o += 2; return v }
  u16(): number { const v = this.b.readUInt16BE(this.o); this.o += 2; return v }
  i32(): number { const v = this.b.readInt32BE(this.o); this.o += 4; return v }
  u32(): number { const v = this.b.readUInt32BE(this.o); this.o += 4; return v }
  i64(): bigint { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v }
  f64(): number { const v = this.b.readDoubleBE(this.o); this.o += 8; return v }
  uvar(): number { let v = 0, s = 0, x; do { x = this.b[this.o++]; v += (x & 0x7f) * 2 ** s; s += 7 } while (x & 0x80); return v }
  var(): number { const u = this.uvar(); return u % 2 === 0 ? u / 2 : -(u + 1) / 2 }
  varlong(): bigint { let v = 0n, s = 0n, x; do { x = this.b[this.o++]; v |= BigInt(x & 0x7f) << s; s += 7n } while (x & 0x80); return (v >> 1n) ^ -(v & 1n) }
  raw(n: number): Buffer { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v }
}
export class Writer {
  parts: Buffer[] = []
  len = 0
  push(b: Buffer): this { this.parts.push(b); this.len += b.length; return this }
  i8(v: number): this { const b = Buffer.alloc(1); b.writeInt8(v); return this.push(b) }
  i16(v: number): this { const b = Buffer.alloc(2); b.writeInt16BE(v); return this.push(b) }
  u16(v: number): this { const b = Buffer.alloc(2); b.writeUInt16BE(v); return this.push(b) }
  i32(v: number): this { const b = Buffer.alloc(4); b.writeInt32BE(v); return this.push(b) }
  u32(v: number): this { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return this.push(b) }
  i64(v: bigint | number): this { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); return this.push(b) }
  f64(v: number): this { const b = Buffer.alloc(8); b.writeDoubleBE(v); return this.push(b) }
  uvar(v: number): this { const o: number[] = []; while (v >= 0x80) { o.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80) } o.push(v); return this.push(Buffer.from(o)) }
  var(v: number): this { return this.uvar(v >= 0 ? v * 2 : -v * 2 - 1) }
  varlong(v: bigint): this { let u = (v << 1n) ^ (v >> 63n); const o: number[] = []; while (u >= 0x80n) { o.push(Number(u & 0x7fn) | 0x80); u >>= 7n } o.push(Number(u)); return this.push(Buffer.from(o)) }
  buf(): Buffer { return Buffer.concat(this.parts, this.len) }
}

// ── the generic codec ──────────────────────────────────────────────────────
const PRIM = new Set(['bool', 'int8', 'int16', 'uint16', 'int32', 'int64', 'float64', 'string', 'bytes', 'records', 'uuid'])
const defaultOf = (f: Field, v: number): unknown => {
  const t = f.type
  if (t.startsWith('[]')) return inRange(f.nullableVersions, v) && f.default === 'null' ? null : []
  if (f.default !== undefined) {
    if (f.default === 'null') return null
    if (t === 'int64') return BigInt(f.default as any)
    if (t === 'bool') return f.default === true || f.default === 'true'
    if (t === 'string') return String(f.default)
    return Number(f.default)
  }
  if (t === 'int64') return 0n
  if (t === 'bool') return false
  if (t === 'string') return inRange(f.nullableVersions, v) ? null : ''
  if (t === 'bytes' || t === 'records') return inRange(f.nullableVersions, v) ? null : Buffer.alloc(0)
  if (t === 'uuid') return Buffer.alloc(16)
  if (PRIM.has(t)) return 0
  return null
}

export class Codec {
  readonly spec: Spec
  readonly structs = new Map<string, Field[]>()
  readonly flex: string
  constructor(spec: Spec) {
    this.spec = spec
    this.flex = spec.flexibleVersions
    for (const c of spec.commonStructs ?? []) this.structs.set(c.name, c.fields)
  }
  #fieldsOf(f: Field): Field[] { return f.fields ?? this.structs.get(f.type.replace(/^\[\]/, '')) ?? [] }

  decode(r: Reader, v: number): Record<string, any> { return this.#readStruct(r, this.spec.fields, v) }
  encode(obj: Record<string, any>, v: number): Buffer { const w = new Writer(); this.#writeStruct(w, this.spec.fields, obj, v); return w.buf() }

  #readStruct(r: Reader, fields: Field[], v: number): Record<string, any> {
    const flex = inRange(this.flex, v)
    const o: Record<string, any> = {}
    for (const f of fields) {
      if (!inRange(f.versions, v)) continue
      if (flex && f.tag !== undefined && inRange(f.taggedVersions ?? f.versions, v)) { o[f.name] = defaultOf(f, v); continue }
      o[f.name] = this.#read(r, f, v, flex)
    }
    if (flex) {
      const n = r.uvar()
      for (let i = 0; i < n; i++) {
        const tag = r.uvar(), size = r.uvar()
        const f = fields.find((x) => x.tag === tag && inRange(x.taggedVersions ?? x.versions, v))
        if (f) o[f.name] = this.#read(new Reader(r.raw(size)), f, v, flex)
        else r.raw(size)
      }
    }
    return o
  }
  #read(r: Reader, f: Field, v: number, flex: boolean): any {
    const t = f.type
    if (t.startsWith('[]')) {
      const n = flex ? r.uvar() - 1 : r.i32()
      if (n < 0) return null
      const et = t.slice(2)
      const out: any[] = []
      for (let i = 0; i < n; i++) out.push(PRIM.has(et) ? this.#prim(r, et, f, v, flex) : this.#readStruct(r, this.#fieldsOf(f), v))
      return out
    }
    if (PRIM.has(t)) return this.#prim(r, t, f, v, flex)
    return this.#readStruct(r, this.#fieldsOf(f), v)
  }
  #prim(r: Reader, t: string, _f: Field, _v: number, flex: boolean): any {
    switch (t) {
      case 'bool': return r.i8() !== 0
      case 'int8': return r.i8()
      case 'int16': return r.i16()
      case 'uint16': return r.u16()
      case 'int32': return r.i32()
      case 'int64': return r.i64()
      case 'float64': return r.f64()
      case 'uuid': return Buffer.from(r.raw(16))
      case 'string': { const n = flex ? r.uvar() - 1 : r.i16(); return n < 0 ? null : r.raw(n).toString('utf8') }
      case 'bytes': case 'records': { const n = flex ? r.uvar() - 1 : r.i32(); return n < 0 ? null : Buffer.from(r.raw(n)) }
    }
    throw new Error('kafka-codec: type ' + t)
  }

  #writeStruct(w: Writer, fields: Field[], o: Record<string, any>, v: number): void {
    const flex = inRange(this.flex, v)
    const tagged: [number, Buffer][] = []
    for (const f of fields) {
      if (!inRange(f.versions, v)) continue
      const val = o?.[f.name] === undefined ? defaultOf(f, v) : o[f.name]
      if (flex && f.tag !== undefined && inRange(f.taggedVersions ?? f.versions, v)) {
        if (val === null || val === undefined || (Array.isArray(val) && val.length === 0)) continue
        const tw = new Writer(); this.#write(tw, f, val, v, flex); tagged.push([f.tag, tw.buf()]); continue
      }
      this.#write(w, f, val, v, flex)
    }
    if (flex) { w.uvar(tagged.length); for (const [t, b] of tagged.sort((a, b) => a[0] - b[0])) w.uvar(t).uvar(b.length).push(b) }
  }
  #write(w: Writer, f: Field, val: any, v: number, flex: boolean): void {
    const t = f.type
    if (t.startsWith('[]')) {
      if (val === null) { if (flex) w.uvar(0); else w.i32(-1); return }
      if (flex) w.uvar(val.length + 1); else w.i32(val.length)
      const et = t.slice(2)
      for (const x of val) { if (PRIM.has(et)) this.#wprim(w, et, x, flex); else this.#writeStruct(w, this.#fieldsOf(f), x, v) }
      return
    }
    if (PRIM.has(t)) { this.#wprim(w, t, val, flex); return }
    this.#writeStruct(w, this.#fieldsOf(f), val ?? {}, v)
  }
  #wprim(w: Writer, t: string, x: any, flex: boolean): void {
    switch (t) {
      case 'bool': w.i8(x ? 1 : 0); return
      case 'int8': w.i8(x); return
      case 'int16': w.i16(x); return
      case 'uint16': w.u16(x); return
      case 'int32': w.i32(x); return
      case 'int64': w.i64(x); return
      case 'float64': w.f64(x); return
      case 'uuid': w.push(x ?? Buffer.alloc(16)); return
      case 'string': {
        if (x === null) { if (flex) w.uvar(0); else w.i16(-1); return }
        const b = Buffer.from(String(x), 'utf8')
        if (flex) w.uvar(b.length + 1); else w.i16(b.length)
        w.push(b); return
      }
      case 'bytes': case 'records': {
        if (x === null) { if (flex) w.uvar(0); else w.i32(-1); return }
        if (flex) w.uvar(x.length + 1); else w.i32(x.length)
        w.push(x); return
      }
    }
    throw new Error('kafka-codec: type ' + t)
  }
}

/** CRC-32C (Castagnoli), as record batches use */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1; t[n] = c } return t })()
export const crc32c = (b: Buffer): number => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
