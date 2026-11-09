// E-19 (Node): what a slot-shaped position costs in the record header, against one offset.
// Encodes and decodes batches of 256 records of 100 B payloads in four header forms and reports
// bytes per record and ns per record (encode, and header-only decode: walk every header, skip payloads).
//
// Batch header (the same in every form): term varint, base offset varint, writer time u64, count varint.
// Per record, every form: issuer varint, call id varint, payload length varint, payload.
// Form extras per record:
//   off        nothing (offset = base + index)                       CELL, LANE, SPLIT
//   slot       slot varint + slot sequence varint                    MIN family, as DESIGN-V5 §4.3 writes it
//   slotfix    slot u16 + sequence u32, fixed width                  a fixed-width variant
//   slotimp    slot varint only; the sequence is implicit: the decoder keeps one counter per slot
//              and checkpoints the 1,024 counters once per segment   (a cheaper variant, priced here)
// Usage: node header.mjs [secs=2] [seqbase=1000000] > results line (JSON)
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const SECS = Number(args.secs || 2);
const SLOTS = 1024, BATCH = 256, PAY = 100;

function makeBatchInput(seed, seqBase) {
  // uniform slots; each slot's sequence starts near seqBase (a resource that has seen seqBase*1024 writes)
  let s = seed | 0 || 1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  const slot = new Uint16Array(BATCH), issuer = new Uint32Array(BATCH), call = new Uint32Array(BATCH);
  for (let i = 0; i < BATCH; i++) { slot[i] = Math.floor(rnd() * SLOTS); issuer[i] = 1 + Math.floor(rnd() * 200); call[i] = 1e6 + Math.floor(rnd() * 1e5); }
  return { slot, issuer, call };
}

const buf = Buffer.alloc(BATCH * (PAY + 32) + 64);
const payload = Buffer.alloc(PAY, 0x5a);
let p = 0;
function vu(v) { while (v >= 128) { buf[p++] = (v & 127) | 128; v = Math.floor(v / 128); } buf[p++] = v; }
function vu32(v) { while (v >= 128) { buf[p++] = (v & 127) | 128; v >>>= 7; } buf[p++] = v; }

function encode(form, inp, seq, term, base) {
  p = 0;
  vu32(term); vu(base); buf.writeDoubleLE(1.7e12, p); p += 8; vu32(BATCH);
  const { slot, issuer, call } = inp;
  for (let i = 0; i < BATCH; i++) {
    vu32(issuer[i]); vu32(call[i]);
    if (form === 1) { const sl = slot[i]; vu32(sl); vu(++seq[sl]); }
    else if (form === 2) { const sl = slot[i]; buf[p] = sl & 255; buf[p + 1] = sl >>> 8; buf.writeUInt32LE((++seq[sl]) >>> 0, p + 2); p += 6; }
    else if (form === 3) { const sl = slot[i]; vu32(sl); ++seq[sl]; }
    vu32(PAY); payload.copy(buf, p); p += PAY;
  }
  return p;
}

let q = 0;
function rv() { let v = 0, mul = 1, b; do { b = buf[q++]; v += (b & 127) * mul; mul *= 128; } while (b & 128); return v; }
// header-only decode: returns a checksum so the work is not optimised away
function decode(form, n, cnt) {
  q = 0; let acc = 0;
  const term = rv(), base = rv(); q += 8; const count = rv(); acc += term + base;
  for (let i = 0; i < count; i++) {
    acc += rv(); acc += rv();
    if (form === 1) { const sl = rv(); acc += sl + rv(); }
    else if (form === 2) { const sl = buf[q] | (buf[q + 1] << 8); acc += sl + buf.readUInt32LE(q + 2); q += 6; }
    else if (form === 3) { const sl = rv(); acc += sl + (++cnt[sl]); }
    const len = rv(); q += len;
  }
  if (q !== n) throw new Error(`decode ${q} != ${n}`);
  return acc;
}

const FORMS = ['off', 'slot', 'slotfix', 'slotimp'];
const out = { exp: 'E-19', impl: 'node', node: process.version, batch: BATCH, payload: PAY, secs: SECS, loadavg: '', rows: [] };
const { readFileSync } = await import('node:fs');
out.loadavg = readFileSync('/proc/loadavg', 'utf8').trim();
const seqBases = String(args.seqbase || '1000,1000000,1000000000').split(',').map(Number);
const inputs = Array.from({ length: 16 }, (_, k) => makeBatchInput(k * 7919 + 1, 0));
let sink = 0;
for (const seqBase of seqBases) {
  for (let f = 0; f < FORMS.length; f++) {
    const seq = new Float64Array(SLOTS).fill(seqBase), cnt = new Float64Array(SLOTS).fill(seqBase);
    // bytes per record (exact, over the 16 inputs)
    let bytes = 0; for (const inp of inputs) { const s2 = new Float64Array(SLOTS).fill(seqBase); bytes += encode(f, inp, s2, 7, 123456789); }
    const perRec = bytes / (inputs.length * BATCH);
    // warm up, then time encode and decode separately
    for (let i = 0; i < 20000; i++) { const n = encode(f, inputs[i & 15], seq, 7, 123456789 + i * BATCH); sink += decode(f, n, cnt); }
    let t0 = process.hrtime.bigint(), it = 0; const until = Number(t0) + SECS * 1e9;
    while (true) { for (let k = 0; k < 256; k++) { encode(f, inputs[(it + k) & 15], seq, 7, 123456789 + (it + k) * BATCH); } it += 256; if (Number(process.hrtime.bigint()) > until) break; }
    const encNs = Number(process.hrtime.bigint() - t0) / (it * BATCH);
    const n = encode(f, inputs[0], new Float64Array(SLOTS).fill(seqBase), 7, 123456789);
    t0 = process.hrtime.bigint(); it = 0; const until2 = Number(t0) + SECS * 1e9;
    while (true) { for (let k = 0; k < 256; k++) sink += decode(f, n, cnt); it += 256; if (Number(process.hrtime.bigint()) > until2) break; }
    const decNs = Number(process.hrtime.bigint() - t0) / (it * BATCH);
    out.rows.push({ form: FORMS[f], seq_base: seqBase, bytes_per_record: +perRec.toFixed(3), header_bytes_per_record: +(perRec - PAY).toFixed(3), enc_ns: +encNs.toFixed(2), dec_ns: +decNs.toFixed(2) });
  }
}
out.sink = sink % 1000;
console.log(JSON.stringify(out));
