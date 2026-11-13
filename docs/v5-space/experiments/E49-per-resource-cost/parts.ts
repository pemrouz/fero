// E-49 parts: what one member holds for each resource, part by part, with R resources in one process.
// One part and one R per process, so parts never share a heap. Memory is heapUsed + arrayBuffers after two
// forced GCs (typed arrays keep their bytes outside the V8 heap), and RSS, before and after building R units;
// "per resource" = the difference / R. Also the build time per unit (what a boot or a create pays for it).
//   node --expose-gc parts.ts part=<name> R=<n>        env: TREE (built by tree.sh)
//   drop=1 (dir-host, dir-host-indexed): then server 0's link dies and the host drops its R entries (a link death)
// Real code used: E-10's TypeScript port of etcd raft (the home group); v4's data seam (api/substrate.ts, the
// fold); v4's directory host (api/directory.ts hostMethods, the `#directory` registry) and v4's frame codec
// (kernel/codec.ts encodeControl, the bytes of a register call). The rest are the plain JS forms each record
// would take (settings, group record, slot table, per-slot state, a client's per-source state, dormant index).
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { Config, RawNode, MemoryStorage, IsEmptyHardState, StateLeader, discardLogger, pb } from '../E10-raft-port/port/src/index.ts';

const args: Record<string, string> = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const PART = args.part, R = Number(args.R);
const SLOTS = 4096;                                            // V5-2: 4,096 slots per resource
const TREE = process.env.TREE; if (!TREE) throw new Error('set TREE (tree.sh)');
const S = await import(pathToFileURL(TREE + '/fero/api/substrate.ts').href);
const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href);
const DIR = await import(pathToFileURL(TREE + '/fero/api/directory.ts').href);
const C = await import(pathToFileURL(TREE + '/fero/kernel/codec.ts').href);
const gc = (globalThis as any).gc; if (!gc) throw new Error('run with --expose-gc');
const mem = () => { gc(); gc(); const m = process.memoryUsage(); return { heap: m.heapUsed + m.arrayBuffers, rss: m.rss }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the records a resource keeps (sizes as V5-2 has them)
// a name like the owner's fixed resources (users, events, orders) plus a number, so 100,000 are distinct
const nameOf = (i: number) => 'orders-' + (1e6 + i).toString(36) + '-' + (i % 97);
// the home log's founding batch: settings, the slot table (one run: every slot in the home group), the group record
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const homeBatch = (i: number) => enc({ s: { n: nameOf(i), id: i, inc: 1, copies: 3, dur: 'persisted', ret: 86400, slots: SLOTS, fv: 1 },
  t: [[0, SLOTS, 1, 0]], g: { g: 1, inc: 1, slots: [[0, SLOTS]], reps: [1, 2, 3] } });
const settingsOf = (i: number) => ({ name: nameOf(i), id: i, inc: 1, copies: 3, durability: 'persisted', retention: 86400, slots: SLOTS,
  foldVersion: 1, codeHash: 'h' + (1e9 + i).toString(16), created: 1.7e12 + i, state: 'live' });
const groupRecordOf = (i: number) => ({ group: 1, inc: 1, slots: [0, SLOTS], replicas: [1, 2, 3], leaderHint: 1 + (i % 3), term: 2 });

// ---------------------------------------------------------------- the home group, as E-11/E-26 make it
const voters = [1, 2, 3];
function storageAt(idx: number, term: number) {
  const st = new MemoryStorage();
  st.ApplySnapshot(new pb.Snapshot({ Metadata: new pb.SnapshotMetadata({ Index: idx, Term: term, ConfState: new pb.ConfState({ Voters: voters }) }) }));
  return st;
}
const cfg = (id: number, st: MemoryStorage, applied: number) => new Config({ ID: id, ElectionTick: 4, HeartbeatTick: 1, Storage: st, Applied: applied,
  MaxSizePerMsg: 1 << 20, MaxInflightMsgs: 256, PreVote: true, CheckQuorum: true, Logger: discardLogger });
// found one resource's home group in-process: three replicas, replica 1 campaigns, then writes the founding batch;
// messages are handed over synchronously (persist, then send, as etcd's contract); then each replica compacts its
// in-memory log at its applied index, as a host that snapshots its fold does. Returns the three replicas.
function foundGroup(i: number) {
  const ns = voters.map((id) => { const st = storageAt(1, 1); return { rn: new RawNode(cfg(id, st, 1)), st }; });
  ns[0].rn.Campaign();
  pump(ns);
  if (ns[0].rn.raft.state !== StateLeader) throw new Error('no leader');
  ns[0].rn.Propose(homeBatch(i));
  pump(ns);
  for (const n of ns) n.st.Compact(n.rn.raft.raftLog.applied);   // an Error here (already compacted) is harmless
  return ns;
}
function pump(ns: { rn: RawNode; st: MemoryStorage }[]) {
  for (let round = 0; round < 50; round++) {
    const out: pb.Message[] = [];
    for (const n of ns) {
      if (!n.rn.HasReady()) continue;
      const rd = n.rn.Ready();
      if (!IsEmptyHardState(rd.HardState)) n.st.SetHardState(rd.HardState!);
      if (rd.Entries.length) n.st.Append(rd.Entries);
      for (const m of rd.Messages) out.push(m);
      n.rn.Advance(rd);
    }
    if (!out.length) return;
    for (const m of out) ns[(m.To ?? 0) - 1].rn.Step(m);
  }
  throw new Error('pump did not settle');
}
// open a group at boot from its stored state (E-26's wake path): a follower at (index, term) with its hard state
const openGroup = () => { const st = storageAt(3, 2); st.SetHardState(new pb.HardState({ Term: 2, Vote: 1, Commit: 3 })); return new RawNode(cfg(2, st, 3)); };

// ---------------------------------------------------------------- the fold (data), as a full copy holds it
const row = (i: number, s: number) => ({ name: 'user-' + i, email: 'u' + i + '@example.com', region: 'r' + (i % 16), room: i % 100, n: s, active: (i & 1) === 0, tags: ['a', 'b'] });
function foldWith(rows: number, i: number) {
  const p = S.proxy({});
  if (rows) {
    const lane = D.lane(p, { origin: S.ORIGIN, onReject: (rj: any) => { throw rj.error; } });
    const recs = []; for (let j = 0; j < rows; j++) recs.push({ type: 1, key: [], at: 'k' + (i * 1000 + j), value: row(i * 1000 + j, 0) });
    lane(recs);
  }
  return p;
}

// ---------------------------------------------------------------- per-slot state forms (sequence, epoch, fence per slot)
const touchedSlots = (i: number, t: number) => { const s = new Set<number>(); let k = 0; while (s.size < t) s.add((i * 7919 + (k++) * 131) % SLOTS); return [...s].sort((a, b) => a - b); };
// packed: the touched slots in one sorted byte array: u16 slot, u32 seq, u32 epoch, f64 fence (18 B each), found by binary search
function packed(i: number, t: number) {
  const b = new Uint8Array(t * 18); const dv = new DataView(b.buffer);
  touchedSlots(i, t).forEach((s, k) => { dv.setUint16(k * 18, s, true); dv.setUint32(k * 18 + 2, 5 + k, true); dv.setUint32(k * 18 + 6, 0, true); dv.setFloat64(k * 18 + 10, 0, true); });
  return b;
}

// ---------------------------------------------------------------- the directory host (v4's real registry)
const peersUp: Record<string, { up: boolean }> = {};
let host: any = null;
const uuidOf = (s: number) => `0f1e2d3c-4b5a-4968-8778-${(0x100000000000 + s).toString(16).slice(1)}`;   // one per server process
const listenOf = (s: number) => `10.0.0.${s + 1}:4001`;
// v4 caps one caller at MAX_PER_CALLER entries (api/directory.ts); past it, the harness spreads a server's entries
// over several caller ids so the registry itself can be measured at R = 100,000 (v4 as written refuses there)
const peerOf = (s: number, i: number) => `srv${s}#${Math.floor(i / DIR.MAX_PER_CALLER)}`;

// ---------------------------------------------------------------- the parts
type Out = Record<string, unknown>;
const parts: Record<string, { make: (i: number) => unknown; after?: () => Promise<Out>; note: string }> = {
  base: { make: () => null, note: 'nothing (the control)' },
  // Raft
  'raft-founded': { make: (i) => foundGroup(i), note: 'home group founded in-process: 3 replicas (1 leader, 2 followers), founding batch committed, logs compacted; per member = /3' },
  'raft-member': { make: (i) => { const n = foundGroup(i)[i % 3]; return n; }, note: 'one member\'s copy: founded as above, this member keeps replica i % 3 (it leads a third of the groups), the other two are dropped' },
  'raft-open': { make: () => openGroup(), note: 'a follower opened from stored hard state (the boot path, E-26 makeGroup)' },
  // records in the home log, held applied in memory
  settings: { make: (i) => settingsOf(i), note: 'the settings record as an object (was the #meta catalog row)' },
  'group-record': { make: (i) => groupRecordOf(i), note: 'the group record (slots, replicas, leader hint) as an object' },
  'slot-dense': { make: () => ({ group: new Uint32Array(SLOTS), epoch: new Uint32Array(SLOTS) }), note: 'slot table: 4,096 x (group u32, epoch u32) typed arrays' },
  'slot-rows': { make: () => Array.from({ length: SLOTS }, () => ({ group: 1, epoch: 0 })), note: 'slot table: 4,096 row objects' },
  'slot-rle': { make: () => [{ start: 0, len: SLOTS, group: 1, epoch: 0 }], note: 'slot table: run-length, one run' },
  'perslot-dense': { make: () => ({ seq: new Float64Array(SLOTS), epoch: new Int32Array(SLOTS), fence: new Float64Array(SLOTS) }), note: 'per-slot state dense: seq f64, epoch i32, fence f64 x 4,096' },
  'perslot-map-1': { make: (i) => { const m = new Map(); for (const s of touchedSlots(i, 1)) m.set(s, { seq: 5, epoch: 0, fence: 0 }); return m; }, note: 'per-slot state: Map of touched slots, 1 touched' },
  'perslot-map-10': { make: (i) => { const m = new Map(); for (const s of touchedSlots(i, 10)) m.set(s, { seq: 5, epoch: 0, fence: 0 }); return m; }, note: '10 touched' },
  'perslot-map-100': { make: (i) => { const m = new Map(); for (const s of touchedSlots(i, 100)) m.set(s, { seq: 5, epoch: 0, fence: 0 }); return m; }, note: '100 touched' },
  'perslot-packed-1': { make: (i) => packed(i, 1), note: 'per-slot state packed: one sorted byte array, 18 B per touched slot; 1 touched' },
  'perslot-packed-10': { make: (i) => packed(i, 10), note: '10 touched' },
  'perslot-packed-100': { make: (i) => packed(i, 100), note: '100 touched' },
  'perslot-packed-4096': { make: (i) => packed(i, SLOTS), note: 'every slot touched' },
  // the fold
  'fold-empty': { make: (i) => foldWith(0, i), note: 'an empty data source through the seam (S.proxy)' },
  'fold-10': { make: (i) => foldWith(10, i), note: 'a data source with 10 rows of about 100 B (E-05 rows)' },
  'fold-100': { make: (i) => foldWith(100, i), note: 'a data source with 100 rows' },
  // directory
  'dir-host': {
    make: (i) => { const name = nameOf(i); for (let s = 0; s < 3; s++) { const peer = peerOf(s, i); peersUp[peer] = { up: true }; host.methods.register({ name, uuid: uuidOf(s), listen: listenOf(s) }, { peer }); } return null; },
    after: async () => { await sleep(10); return {}; },
    note: "v4's #directory host (api/directory.ts hostMethods): 3 entries per resource, one per copy's server",
  },
  // the same registry (a data source of name -> {uuid: listen}) and owner maps as v4's host, with one change: whether a
  // name exists is read from a Set, not from snapshot(registry) (api/directory.ts:229 and :275, which copies the whole
  // registry on every register, so v4's register grows with the registry and a full re-announce is quadratic)
  'dir-host-indexed': {
    make: (i) => { const name = nameOf(i); for (let s = 0; s < 3; s++) { const peer = peerOf(s, i); idx.register(name, uuidOf(s), listenOf(s), peer); } return null; },
    note: "v4's registry and owner maps with an index of names in place of the snapshot read (the one-line fix)",
  },
  'dir-names': { make: (i) => nameOf(i), note: "a server's own list of the names it announces (a string per resource)" },
  // client side, per followed source
  'client-source': {
    make: (i) => ({ name: nameOf(i), members: [0, 1, 2].map((s) => listenOf(s) + ''), table: [{ start: 0, len: SLOTS, group: 1, epoch: 0 }], leaders: new Map([[1, 1 + (i % 3)]]),
      cursor: new Map(touchedSlots(i, 10).map((s, k) => [s, 5 + k])), sub: { id: i, at: 0 } }),
    note: "a client's state per followed source: members, slot table (one run), leader, a cursor of 10 touched slots, the subscription",
  },
  'client-source-off': {
    make: (i) => ({ name: nameOf(i), members: [0, 1, 2].map((s) => listenOf(s) + ''), table: null, leader: 1 + (i % 3), cursor: 0, sub: i }),
    note: 'the same with an implicit table and a one-number cursor (one group, no moves)',
  },
  // timers, as v4 keeps them per resource; the base keeps one ticker per process
  timers: { make: () => setInterval(() => {}, 500), note: 'one setInterval(500 ms) per resource' },
  // assembled: everything one member holds for an idle (quiet) resource, in the cheap and the drafted forms
  'asm-cheap': { make: (i) => [foundGroup(i)[i % 3], settingsOf(i), groupRecordOf(i), [{ start: 0, len: SLOTS, group: 1, epoch: 0 }], packed(i, 10), foldWith(0, i), nameOf(i)],
    note: 'assembled, cheap form: member copy of the home group + settings + group record + one-run slot table + packed per-slot state (10 touched) + empty fold + announced name' },
  'asm-drafted': { make: (i) => [foundGroup(i)[i % 3], settingsOf(i), groupRecordOf(i), { group: new Uint32Array(SLOTS), epoch: new Uint32Array(SLOTS) },
    { seq: new Float64Array(SLOTS), epoch: new Int32Array(SLOTS), fence: new Float64Array(SLOTS) }, foldWith(0, i), nameOf(i)],
    note: 'assembled, drafted form: the same with a dense 4,096-slot table and dense per-slot state' },
  // sockets as v4 keeps them per resource: each resource listens on its own port (listen(0)); the base listens once per process
  listen: { make: () => { const srv = net.createServer(); srv.listen(0, '127.0.0.1'); return srv; }, after: async () => { await sleep(200); return {}; },
    note: 'one listening TCP socket per resource (v4: a port per resource)' },
  // dormant: what stays in memory for a resource whose group sleeps (E-26: one Map entry per group) and its name
  dormant: { make: (i) => i, note: 'group id -> store offset (Map) plus name -> id (Map)' },
};

const idx = (() => {   // the indexed host: v4's state (registry proxy, owner, owners), names kept in a Set
  const registry: any = S.proxy({}); const names = new Set<string>(); const owner = new Map<string, string>(); const owners = new Map<string, Set<string>>();
  return { registry, register(name: string, uuid: string, listen: string, peer: string) {
    let mine = owners.get(peer); if (!mine) owners.set(peer, (mine = new Set()));
    const k = JSON.stringify([name, uuid]); owner.set(k, peer); mine.add(k);
    if (!names.has(name)) { registry.set(name, { [uuid]: listen }); names.add(name); } else registry.get(name).set(uuid, listen);
  },
  // a registrant's link dies: v4's forget() and drop() (api/directory.ts:230-239), with drop's whole-registry read
  // (rows() at :233) replaced by the owner map, which already holds every live (name, uuid) cell: the same fix again
  forget(peer: string) {
    const keys = owners.get(peer); owners.delete(peer); if (!keys) return 0; let n = 0;
    for (const k of keys) { if (owner.get(k) !== peer) continue; owner.delete(k); const [name, uuid] = JSON.parse(k); registry.get(name).get(uuid).remove(); n++; }
    return n;
  } };
})();
const part = parts[PART]; if (!part) throw new Error('unknown part ' + PART);
if (PART === 'dir-host') host = DIR.hostMethods(() => peersUp);
const dormantIdx = new Map<number, number>(), dormantNames = new Map<string, number>();
let keep: unknown[] = new Array(R).fill(null);   // the holder's slots exist before the first reading
const m0 = mem();
const c0 = process.cpuUsage();
const t0 = performance.now();
for (let i = 0; i < R; i++) {
  if (PART === 'dormant') { dormantIdx.set(i, i * 24); dormantNames.set(nameOf(i), i); continue; }
  keep[i] = part.make(i);
}
const t1 = performance.now();
const c1 = process.cpuUsage(c0);
const extra: Out = part.after ? await part.after() : {};
const m1 = mem();
const out: Out = { exp: 'E-49', part: PART, R, note: part.note, node: process.version,
  heap_B_per_res: Math.round((m1.heap - m0.heap) / R), rss_B_per_res: Math.round((m1.rss - m0.rss) / R),
  heap_MB: +((m1.heap) / 2 ** 20).toFixed(1), rss_MB: +(m1.rss / 2 ** 20).toFixed(1),
  build_ms: +(t1 - t0).toFixed(1), build_us_per_res: +((t1 - t0) * 1000 / R).toFixed(2), build_cpu_us_per_res: +((c1.user + c1.system) / R).toFixed(2), ...extra };
if (PART === 'raft-founded') { out.heap_B_per_replica = Math.round((m1.heap - m0.heap) / R / 3); out.rss_B_per_replica = Math.round((m1.rss - m0.rss) / R / 3); }
if (PART === 'listen') for (const srv of keep) (srv as net.Server).close();
if (PART === 'timers') {   // idle CPU of R timers over a 5 s window
  const w0 = process.cpuUsage(); await sleep(5000); const w = process.cpuUsage(w0);
  out.idle_cores = +(((w.user + w.system) / 1e6) / 5).toFixed(4);
  for (const t of keep) clearInterval(t as any);
}
if (PART === 'dir-host-indexed') {   // what v4's register adds at this size: one snapshot of a registry of R names
  const t = performance.now(); for (let k = 0; k < 5; k++) S.snapshot(idx.registry); out.v4_snapshot_us_at_R = +((performance.now() - t) * 1000 / 5).toFixed(1);
}
if (PART === 'dir-host' || PART === 'dir-host-indexed') {   // the wire: bytes of one register call and its answer in v4's codec; one batched announcement
  const name = nameOf(R - 1);
  out.call_B = C.encodeControl(C.VERB.CALL, { id: R, m: 'register', a: { name, uuid: uuidOf(0), listen: listenOf(0) } }).length;
  out.result_B = C.encodeControl(C.VERB.RESULT, { id: R, ok: true, v: true }).length;
  const names = Array.from({ length: R }, (_, i) => nameOf(i));
  const e0 = performance.now(); const batch = C.encodeControl(C.VERB.CALL, { id: 1, m: 'announce', a: { uuid: uuidOf(0), listen: listenOf(0), names } }); const e1 = performance.now();
  out.batch_B = batch.length; out.batch_encode_ms = +(e1 - e0).toFixed(2);
  out.register_us = out.build_us_per_res; out.entries = 3 * R;
  out.register_us_per_entry = +((t1 - t0) * 1000 / (3 * R)).toFixed(2);
}
if (args.drop === '1' && (PART === 'dir-host' || PART === 'dir-host-indexed')) {   // a link death: server 0's link closes, all its R entries go
  const callers = Object.keys(PART === 'dir-host' ? peersUp : {}).filter((p) => p.startsWith('srv0#'));
  const t = performance.now(); let n = 0;
  if (PART === 'dir-host') { for (const p of callers) peersUp[p] = { up: false }; host.onPeers(); await null; n = R; }   // v4's peer-down cleanup (forget, then drop per entry)
  else for (let k = 0; k * DIR.MAX_PER_CALLER < R; k++) n += idx.forget(`srv0#${k}`);
  const ms = performance.now() - t;
  out.drop_entries = n; out.drop_ms = +ms.toFixed(1); out.drop_us_per_entry = +(ms * 1000 / n).toFixed(2);
  // check: the first and the last resource keep only their two other copies
  const copiesLeft = (i: number) => Object.keys((S.snapshot(PART === 'dir-host' ? host.methods.lookup(nameOf(i)) : idx.registry.get(nameOf(i))) ?? {}) as object).length;
  out.drop_check_copies_left = [copiesLeft(0), copiesLeft(R - 1)];
}
console.log(JSON.stringify(out));
keep = [];
process.exit(0);
