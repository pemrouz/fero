//! ── sim/fold — the object a screen shows, folded from the kernel's applies ─────
// The kernel's `state` is a flat map of cells; what a person sees is those cells
// folded by depth into one object — a row cell replaces the row, a field cell
// lands inside it, a remove deletes at its path. The api's lane (api/substrate.ts
// applyRec) does this through data; the sim does it here, record by record, in
// EVERY node's sink (sim/exec.ts), so the oracle projected() (sim/monitors.ts)
// can compare what reached downstream with what the kernel holds, and across
// nodes. A fold never writes into a value the kernel still holds: every object
// walked into is copied first (the kernel's row object is shared by reference
// until a field lands inside it).

import { REC } from '../kernel/env.ts'

export type Folded = Record<string, unknown>

const plain = (v: unknown): v is Folded => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)

//! foldInto — apply one record to the folded object: set or delete at its path, vivifying the rows
// above a field (the substrate's orphan-cell vivify); a remove under a row that is not there is a no-op.
// Under an ARRAY (or a typed array) a write and a remove are both ignored. That is a MODEL, not what
// data does: data writes into an array (an index write replaces the element, a field inside an element
// lands, a non-index key becomes a hidden array property) and refuses only a remove of the array's own
// key. The sim's oracle therefore says nothing about what lands under an array — the array limit of the
// across-depth guarantee, which is for object rows (and numbers, null and strings).
export const foldInto = (root: Folded, rec: { type: number; key: string[]; value?: unknown; at?: string }) => {
  const path = rec.key.length ? rec.key : [rec.at ?? '']
  let o = root
  for (let i = 0; i < path.length - 1; i++) {
    const v = o[path[i]]
    if (!plain(v) && (rec.type === REC.remove || (typeof v === 'object' && v !== null))) return
    o = o[path[i]] = plain(v) ? { ...v } : {}
  }
  if (rec.type === REC.remove) delete o[path[path.length - 1]]
  else o[path[path.length - 1]] = rec.value
}
