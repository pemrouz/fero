// E-56 positions, probe: what a version and a cursor could look like as text. Not timed; deterministic.
//   node textform.mjs
// A version is a slot's (epoch, sequence) (DESIGN-V5 4.3 "Positions"; LAYERS 3.2 "Slot sequence"). API.md section 7
// says two versions of one partition compare with plain `<`, and `fero.version.toNumber(v)` gives a number below
// 2^63 that keeps the order. This probe tries two text forms of that number and checks, on 1,000,000 seeded random
// pairs (equal epochs, near sequences, far sequences, epochs apart), that string `<` agrees with the number's `<`:
//   fixed    13 characters of Crockford's base32 (0-9, A-Z without I, L, O, U): 65 bits of room, fixed width
//   prefixed one character for the number of digits that follow, then the base32 digits with no leading zeros:
//            short for small numbers, and still ordered, because a longer number has a larger first character
// The split of the 63 bits is a guess: 23 bits of epoch above 40 bits of sequence (2^40 = 1.1e12 records a slot).
// It also prints a one-partition cursor in E-19's layout (16 B resource id, the resource's incarnation, an entry
// count, then slot, epoch and sequence as varints) as base64url text, and the sizes of whole-resource cursors.
import { rng, out } from './common.mjs'

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
for (let i = 1; i < ALPHA.length; i++) if (ALPHA[i - 1] >= ALPHA[i]) throw new Error('alphabet not ascending')
const SEQ_BITS = 40n
const toNumber = (epoch, seq) => (BigInt(epoch) << SEQ_BITS) | BigInt(seq)
function digits(n) { if (n === 0n) return '0'; let s = ''; while (n > 0n) { s = ALPHA[Number(n & 31n)] + s; n >>= 5n } return s }
const fixed = (n) => digits(n).padStart(13, '0')
const prefixed = (n) => { const d = digits(n); return ALPHA[d.length] + d }
function undo(text) { // prefixed form back to the number, to check it round-trips
  const len = ALPHA.indexOf(text[0]); if (len !== text.length - 1) throw new Error('bad length'); let n = 0n
  for (const c of text.slice(1)) n = (n << 5n) | BigInt(ALPHA.indexOf(c))
  return n
}

// 1,000,000 seeded pairs of four kinds; string < must agree with number < in every one
const r = rng(5619)
const pick = () => {
  const kind = Math.floor(r() * 4)
  const e = Math.floor(r() * 8), s = Math.floor(r() * 2 ** 40)
  if (kind === 0) return [[e, s], [e, Math.min(2 ** 40 - 1, s + 1 + Math.floor(r() * 100))]]             // near, same epoch
  if (kind === 1) return [[e, Math.floor(r() * 1e4)], [e, Math.floor(r() * 1e12)]]                       // short against long
  if (kind === 2) return [[e, s], [e + 1 + Math.floor(r() * 3), Math.floor(r() * 1000)]]                 // a later epoch, a low sequence
  return [[e, s], [Math.floor(r() * 8), Math.floor(r() * 2 ** 40)]]                                      // anything
}
let wrongFixed = 0, wrongPref = 0, roundTrip = 0
const N = 1e6
for (let i = 0; i < N; i++) {
  const [a, b] = pick(), na = toNumber(...a), nb = toNumber(...b)
  const want = na < nb
  if ((fixed(na) < fixed(nb)) !== want) wrongFixed++
  const pa = prefixed(na), pb = prefixed(nb)
  if ((pa < pb) !== want) wrongPref++
  if (undo(pa) !== na) roundTrip++
}

// examples: a version at a few places in a slot's life
const ex = [[0, 1], [0, 9001], [0, 16_777_215], [0, 2_000_000_000], [3, 12]].map(([e, s]) => {
  const n = toNumber(e, s); return { epoch: e, seq: s, number: n.toString(), fixed: fixed(n), prefixed: prefixed(n) }
})

// a one-partition cursor in E-19's layout, as base64url text
const vu = (a, x) => { do { let b = x & 127; x = Math.floor(x / 128); if (x > 0) b |= 128; a.push(b) } while (x > 0) }
function cursor1(slot, epoch, seq) {
  const a = []; for (let i = 0; i < 16; i++) a.push((i * 37 + 11) & 255) // a stand-in resource id
  vu(a, 3); vu(a, 1); vu(a, slot); vu(a, epoch); vu(a, seq)
  return Buffer.from(a).toString('base64url')
}
const cur = [[412, 0, 9001], [4095, 0, 2_000_000_000], [7, 2, 30]].map(([sl, e, s]) => { const t = cursor1(sl, e, s); return { slot: sl, epoch: e, seq: s, bytes: Buffer.from(t, 'base64url').length, chars: t.length, text: t } })
// whole-resource cursors: E-19's delta-coded bytes for 1,024 slots, and API.md's reasoned 4 to 13 KB for 4,096, as base64url
const whole = [1045, 3229, 4000, 13000].map((b) => ({ bytes: b, base64url_chars: Math.ceil(b * 4 / 3) }))

out({ exp: 'E-56', part: 'textform', pairs: N, wrong_fixed: wrongFixed, wrong_prefixed: wrongPref, round_trip_wrong: roundTrip,
  seq_bits: Number(SEQ_BITS), versions: ex, cursor_one_partition: cur, cursor_whole: whole })
