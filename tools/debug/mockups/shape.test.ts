// Round-trip test for the debug-model seam (shape.js). Locks the store-once →
// derive contract that both feeds (the viewer + the future Node producers)
// depend on: a fact lives once on its owner, every cross-cut is DERIVED, so a
// count can't disagree with its children.
//
// Seam boundary for the eventual CAPTURE round-trip (P1+): only a SUBSET of
// normalize()'s inputs has a real fero introspection seam today —
//   epoch / members / peers / marks / versions-COUNT / orphans / ring.
// The richer inputs (per-partition log, per-sub head/delivered, ownerByEpoch,
// per-replica stuck) have NO accessor yet and arrive with P2–P4; until then a
// capture can only round-trip the intersection. This test asserts the
// derivation contract itself, which is what a producer must satisfy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize, deriveOwnerAt, layoutAt } from './shape.js';

const sample = JSON.parse(readFileSync(new URL('./debug/sessions.fero.json', import.meta.url), 'utf8'));

//! the DRY thesis: rollups are DERIVED, never stored — so they can't drift
test('rollup counts are derived from partitions, not stored', () => {
  // the file stores NO resource-level rollup — keys/wps live only on partitions
  const sessionsRaw = sample.resources.find((r: any) => r.name === 'sessions');
  assert.equal(sessionsRaw.keys, undefined, 'file must not store a resource keys rollup');
  assert.equal(sessionsRaw.wps, undefined, 'file must not store a resource wps rollup');

  // every resource's derived rollup equals the sum of its partitions — the
  // invariant the single model makes structurally impossible to violate
  const model = normalize(sample);
  for (const r of model.resources) {
    const raw = sample.resources.find((x: any) => x.name === r.id);
    const keys = (raw.partitions || []).reduce((a: number, p: any) => a + (p.keys || 0), 0);
    const wps = (raw.partitions || []).reduce((a: number, p: any) => a + (p.wps || 0), 0);
    assert.equal(r.keys, keys, `${r.id}: keys must equal sum of partition keys`);
    assert.equal(r.wps, wps, `${r.id}: wps must equal sum of partition wps`);
  }
  // sessions' 16 partitions sum to 2,838 — the number that exposed the old
  // hand-authored "1,284" rollup as never having matched its own partitions
  const sessions = model.resources.find((r: any) => r.id === 'sessions')!;
  assert.equal(sessions.keys, 2838);
  assert.equal(sessions.wps, 325);
});

//! ownership history derives from ownerByEpoch (no separate stored layout)
test('ownership at epoch T is re-projected from ownerByEpoch', () => {
  const model = normalize(sample);
  const sessions = model.resources.find((r: any) => r.id === 'sessions')!;
  const user42 = sessions.parts.find((p: any) => p.id === 'user42')!;

  // the e3→e4 view change: user42 moved :49803 → :49801
  assert.equal(deriveOwnerAt(user42, 'e3'), ':49803');
  assert.equal(deriveOwnerAt(user42, 'e4'), ':49801');

  // layoutAt places the partition under its owner-at-T
  assert.ok(layoutAt(sessions, 'e3')[':49803'].includes('user42'));
  assert.ok(layoutAt(sessions, 'e4')[':49801'].includes('user42'));

  // the e4 epoch records exactly the two partitions that changed hands
  const e4 = sessions.epochs.find((e: any) => e.ep === 'e4')!;
  assert.equal(e4.moves.length, 2);
  assert.ok(e4.moves.some((m: any[]) => m[0] === 'user42' && m[1] === ':49803' && m[2] === ':49801'));
  assert.ok(e4.moves.some((m: any[]) => m[0] === 'billing' && m[1] === ':49809' && m[2] === ':49807'));
});

//! subscription lag is derived (head − delivered), not stored
test('client/sub lag derives from head − delivered', () => {
  const model = normalize(sample);
  const sessions = model.resources.find((r: any) => r.id === 'sessions')!;
  const slow = sessions.clients.find((c: any) => c.id === 'cli-7f3a')!;
  const sub = slow.subs.find((s: any) => s.sub === 'order7.lines')!;
  assert.equal(sub.lag, '+1,840');        // 9210 − 7370, grouped
  assert.equal(slow.lag, 1840);           // client max-lag across its subs
});

//! a terse resource (no nodes/clients/epochs) still renders — derived defaults
test('terse resource fills derived defaults', () => {
  const model = normalize(sample);
  const orders = model.resources.find((r: any) => r.id === 'orders')!;
  assert.equal(orders.keys, 8240);
  assert.equal(orders.nodes.length, 5);   // derived from members[]
  assert.equal(orders.clients.length, 0);
  assert.equal(orders.epochs.length, 2);  // default [e3, current view]
  assert.equal(orders.epochs[1].cur, true);
});

//! normalize is total + pure: arbitrary minimal input never throws, no mutation
test('minimal snapshot normalizes with sensible defaults', () => {
  const min = { resources: [{
    name: 'x', members: [':1', ':2', ':3'],
    partitions: [{ name: 'p1', owner: ':1', keys: 10, wps: 2 },
                 { name: 'p2', owner: ':2', keys: 5, wps: 1 }],
  }] };
  const frozen = JSON.stringify(min);
  const m = normalize(min);
  const x = m.resources[0];

  assert.equal(m.view, 'e4');             // default view
  assert.equal(x.keys, 15);
  assert.equal(x.wps, 3);
  assert.equal(x.members, 3);
  assert.equal(x.nodes.length, 3);        // derived from members
  assert.equal(x.parts[0].held, 5);       // default R
  assert.equal(x.parts[0].st, 'healthy'); // default status
  assert.equal(x.parts[0].log.length, 2); // synthetic log so the row renders
  assert.equal(JSON.stringify(min), frozen, 'normalize must not mutate its input');
});

//! same input → same model (referential purity the producers can rely on)
test('normalize is deterministic', () => {
  const a = normalize(sample), b = normalize(sample);
  assert.deepEqual(a.resources.map((r: any) => [r.id, r.keys, r.wps]),
                   b.resources.map((r: any) => [r.id, r.keys, r.wps]));
});

//! birth-aware (slice 1b): a partition stamped bornAt (from the WAL via foldOwnership) is a
//! PLACEMENT at that view, counted separately from a MOVE — a birth is never miscounted as a move
test('a placement (bornAt) is counted separately from a move', () => {
  const snap = {
    view: 'e3',
    resources: [{
      name: 'r', members: ['A', 'B', 'C'], R: 3,
      epochs: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3', current: true }],
      partitions: [
        { name: 'user42', owner: 'C', bornAt: 'e2', ownerByEpoch: { e2: 'B', e3: 'C' } }, // born e2, handed B→C at e3
        { name: 'order7', owner: 'A', bornAt: 'e1', ownerByEpoch: { e1: 'A', e2: 'A', e3: 'A' } },
      ],
    }],
  };
  const r = normalize(snap).resources[0];
  const e = (id: string) => r.epochs.find((x: any) => x.ep === id)!;
  // born at e2 → PLACED at e2, and NOT moved (no fabricated e1→e2 handoff — the bug this fixes)
  assert.deepEqual(e('e2').placed, ['user42']);
  assert.equal(e('e2').moves.length, 0);
  // its genuine handoff B→C is a MOVE at e3, never a placement
  assert.equal(e('e3').moves.length, 1);
  assert.deepEqual(e('e3').placed, []);
  // e1 records order7's birth as a placement (and user42 has no pre-birth row)
  assert.deepEqual(e('e1').placed, ['order7']);
  // the per-partition owner rows flag the birth row as placed
  assert.equal(r.parts.find((p: any) => p.id === 'user42').owners.find((o: any) => o.ep === 'e2').placed, true);
});

//! without bornAt (no WAL source) behaviour is unchanged — placements stay empty, moves as before
test('no bornAt → no placements (graceful degrade preserves existing move counts)', () => {
  const sessions = normalize(sample).resources.find((r: any) => r.id === 'sessions')!;
  for (const e of sessions.epochs) assert.deepEqual(e.placed, []);
  assert.equal(sessions.epochs.find((e: any) => e.ep === 'e4')!.moves.length, 2); // the existing e3→e4 contract holds
});
