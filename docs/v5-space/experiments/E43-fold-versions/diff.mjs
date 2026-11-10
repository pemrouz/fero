// E-43: compare two per-record result files of the same stream (<x>.dig: the touched row after each record;
// <x>.out: taken or refused). A "root" is a record after which the two rows differ while they agreed after the
// record before it on the same row (or there was none): the two folds parted at that record, it is not an older
// difference carried along. Writes the root record numbers to <roots file> and prints the counts.
//   node diff.mjs <stream dir> <a prefix> <b prefix> <roots file>
import fs from 'node:fs'
const [STREAM, A, B, ROOTS] = process.argv.slice(2)
const meta = JSON.parse(fs.readFileSync(STREAM + '/stream.json', 'utf8'))
const kinds = fs.readFileSync(STREAM + '/stream.kinds')
const kb = fs.readFileSync(STREAM + '/stream.keys'); const keys = new Uint32Array(kb.buffer, kb.byteOffset, kb.length / 4)
const rd = (f) => { const b = fs.readFileSync(f); return new Uint32Array(b.buffer, b.byteOffset, b.length / 4) }
const a = rd(A + '.dig'), b = rd(B + '.dig'), ao = fs.readFileSync(A + '.out'), bo = fs.readFileSync(B + '.out')
const n = Math.min(a.length, b.length)
const agreed = new Uint8Array(meta.nkeys).fill(1)
let differ = 0, outcomeOnly = 0
const roots = [], byKind = new Map(), outKind = new Map()
for (let i = 0; i < n; i++) {
  if (ao[i] === 2 || bo[i] === 2) continue // one side left this record out (not a record of its profile): nothing to compare
  const same = a[i] === b[i], k = keys[i]
  if (!same) { differ++; if (agreed[k]) { roots.push(i); const kind = meta.kinds[kinds[i]]; byKind.set(kind, (byKind.get(kind) ?? 0) + 1) } }
  else if (ao[i] !== bo[i]) { outcomeOnly++; const kind = meta.kinds[kinds[i]]; outKind.set(kind, (outKind.get(kind) ?? 0) + 1) } // same row, but one side refused the record
  agreed[k] = same ? 1 : 0
}
let apart = 0; for (let k = 0; k < meta.nkeys; k++) if (!agreed[k]) apart++
const top = (m) => Object.fromEntries([...m.entries()].sort((x, y) => y[1] - x[1]))
if (ROOTS) fs.writeFileSync(ROOTS, roots.join('\n') + (roots.length ? '\n' : ''))
console.log(JSON.stringify({ records: n, rowDiffers: differ, roots: roots.length, firstRoot: roots[0] ?? null, rowsApartAtEnd: apart, sameRowOtherOutcome: outcomeOnly, rootsByMadeKind: top(byKind), otherOutcomeByKind: top(outKind) }))
