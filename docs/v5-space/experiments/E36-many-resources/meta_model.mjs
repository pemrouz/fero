// E-36: what one idle resource costs in `#meta` and in per-slot state, per candidate, at 1e2, 1e4 and 1e5 resources.
// Two halves:
//  (1) bytes, exact: the `#meta` catalog row and slot table of each form, encoded compactly (varints), per voter;
//  (2) memory, measured: the heap that 10,000 resources' per-slot state and slot tables take in Node 22, per form,
//      by heapUsed + arrayBuffers after a forced GC (run with --expose-gc). Not a timing run.
// Usage: node --expose-gc meta_model.mjs > results/meta_model.json
const SLOTS = 1024;

// ------------------------------------------------------------------ (1) bytes
function vlen(v) { let n = 1; while (v >= 128) { v = Math.floor(v / 128); n++; } return n; }
// catalog row: name ('doc:' + 20 chars), resource id u64, incarnation, copies, rung, retention, created-at u64, state
const CATALOG = 1 + 24 + 8 + vlen(3) + 1 + 1 + vlen(86400) + 8 + 1;
// slot table forms, for a resource whose slots sit in `groups` contiguous ranges after `moves` single-slot moves
const slotTable = {
  raw: () => SLOTS * (4 + 4),                                   // group id u32 + epoch u32 per slot (the draft's 1,024 slot rows)
  rows: () => SLOTS * (2 + vlen(5000) + vlen(1)),                // the same rows with varints
  rle: (groups, moves) => (groups + 2 * moves) * (vlen(1023) + vlen(1024) + vlen(5000) + vlen(1)) + vlen(groups + 2 * moves),   // runs (start, length, group, epoch)
  none: () => 0,                                                 // LANE: lanes by hash, no per-resource table; MIN-P: the project's one shared map
};
const forms = [
  { name: 'MIN, raw slot table (1,024 rows)', table: 'raw', groupsPerRes: 1 },
  { name: 'MIN, slot rows as varints', table: 'rows', groupsPerRes: 1 },
  { name: 'MIN, run-length slot table', table: 'rle', groupsPerRes: 1 },
  { name: 'MIN-P (project groups, one shared slot map per project)', table: 'none', groupsPerRes: 0 },
  { name: 'LANE (64 lanes per project, by hash)', table: 'none', groupsPerRes: 0 },
];
const bytes = [];
for (const R of [1e2, 1e4, 1e5]) {
  const projects = 1;   // one project holding R resources (SC-13)
  for (const f of forms) {
    for (const moves of [0, 10]) {
      if (f.table !== 'rle' && moves) continue;
      const perRes = CATALOG + slotTable[f.table](1, moves);
      const shared = f.name.startsWith('MIN-P') ? slotTable.rle(16, 0) : f.name.startsWith('LANE') ? 64 * (vlen(64) + vlen(5000)) : 0;
      bytes.push({ resources: R, form: f.name, moves_per_resource: moves, catalog_B: CATALOG, slot_table_B: slotTable[f.table](1, moves), per_resource_B: perRes,
        meta_total_per_voter_MB: +((R * perRes + projects * shared) / 1e6).toFixed(3) });
    }
  }
}

// ------------------------------------------------------------------ (2) memory per resource in Node
const gc = globalThis.gc; if (!gc) throw new Error('run with --expose-gc');
const heap = () => { gc(); gc(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };   // typed arrays keep their bytes outside the heap
const K = 10000;   // resources measured at once
const touchedOptions = [1, 10, 100];   // slots a small resource has written
let keep;
function measure(name, make) {
  keep = null; const h0 = heap();
  keep = Array.from({ length: K }, (_, i) => make(i));
  const h1 = heap();
  return { form: name, bytes_per_resource: Math.round((h1 - h0) / K) };
}
const mem = [];
// per-slot state: sequence, epoch and fence position per slot (dedup lives per issuer session in D `sess`, not per slot)
mem.push(measure('per-slot state, dense typed arrays (seq f64, epoch i32, fence f64) x 1,024', () => ({ seq: new Float64Array(SLOTS), epoch: new Int32Array(SLOTS), fence: new Float64Array(SLOTS) })));
for (const t of touchedOptions) mem.push(measure(`per-slot state, sparse Map of touched slots (${t} touched)`, (i) => { const m = new Map(); for (let k = 0; k < t; k++) m.set((i * 7 + k * 131) % SLOTS, { seq: 5 + k, epoch: 0, fence: 0 }); return m; }));
mem.push(measure('slot table as 1,024 row objects {group, epoch}', () => Array.from({ length: SLOTS }, (_, s) => ({ group: 7, epoch: 0 }))));
mem.push(measure('slot table as two typed arrays (group u32, epoch u32) x 1,024', () => ({ group: new Uint32Array(SLOTS), epoch: new Uint32Array(SLOTS) })));
mem.push(measure('slot table run-length coded: one run object', () => [{ start: 0, len: SLOTS, group: 7, epoch: 0 }]));
mem.push(measure('catalog row object (name, id, settings, incarnation)', (i) => ({ name: 'doc:' + String(1e19 + i * 7919).slice(0, 20), id: i, copies: 3, rung: 'persisted', retention: 86400, inc: 1, created: 1.7e12, state: 'live' })));
keep = null;
console.log(JSON.stringify({ exp: 'E-36', part: 'meta-model', node: process.version, slots: SLOTS, catalog_row_B: CATALOG, bytes, mem }));
