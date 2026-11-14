// E-53: the host the hand-back runs on. It is E-26's host (../E26-dormant-groups/host.ts: E-11's TS host on E-10's
// TypeScript port of etcd raft, quiet groups, link pings, one journal with one fdatasync per round), patched into a
// copy at $SP/e53/host/host.ts. E-26's file is not changed.
//
// Patches 1-4 are E-49's (../E49-per-resource-cost/boot.mjs), copied here word for word: the import path and
// globalRand, DESIGN-V5's jitter (jitter=J ticks), no campaign at start (start=random), and a `leaders` command.
//
// Patches 5-12 are what the hand-back needs, and nothing else:
//   5. a restart from disk: journal records carry a type byte (1 = hard state, 2 = entry), and restore=1 rebuilds
//      every group from the journal (hard state plus entries), as a restarted member would; the journal is then
//      appended to, not truncated
//   6. links that die and come back: a dead link is dropped without crashing; the lower id dials again every 50 ms;
//      a follower whose leader's link died wakes its quiet group, so it elects after election.ms plus jitter
//      (DESIGN-V5 4.2 "a quiet shard's leader dies"); when a link comes up, the leader wakes the groups it leads, so
//      a returning member learns its leaders and catches up (DESIGN-V5's "when a link comes back")
//   7. counters on the Raft object's own steps: pre-candidacies (an election started by a timer), candidacies,
//      transfer campaigns (Raft's TimeoutNow) and leaderships won
//   8. a client port (cport=): 13-byte messages, write(g, seq) in; ack(g, seq) on commit, or moved(g, seq, leader).
//      A write that reaches a leader in the middle of a transfer waits for it (DESIGN-V5 4.2 "a planned handover":
//      "writes that arrive meanwhile wait, or get moved with the target"); a write to a non-leader is answered
//      moved with the leader it knows (V5-9: a client writes to its slot's leader)
//   9. recent writes per group, counted where each write is applied (on every member), halved every second: the
//      order busiest-first reads
//  10. the hand-back (command `handback`): each member takes back the groups it is the preferred leader of
//      (g % 3 + 1, as E-26 and E-49 rank them) by Raft's own leadership transfer, asked from its follower replica
//      (etcd raft forwards MsgTransferLeader to the leader, which brings the target up to date and sends
//      TimeoutNow). The pace is either rate=X starts a second (DESIGN-V5's "at most ten leaderships a second") or
//      cap=K transfers in flight (V5-7); the order is random or busy (most recent writes first). A transfer that
//      has not made this member the leader after timeout= ms (3,000: election.ms 2 s plus jitter, past the
//      leader's own abort at election.ms) counts as failed and goes to the back of the list to be tried again
//  11. `hbstat`: leaders, preferred leaderships, awake groups, the sum of terms, the counters
//  12. the hand-back's checks run after every round of the loop and on every tick
//  14. (added after a crash in the liveness check) a dial that connects a socket to itself is dropped and tried again
//  13. (added after a crash in a timed run) a probe that falls back to the founding snapshot (index 1, which every
//      replica already holds; nothing is compacted here) is sent, not refused; etcd raft's follower answers it with
//      its commit offset. E-11's codec threw on any snapshot. Counted (ctr.snap)
// Patches 15-18 were added after the skeptic's check (README, "After the skeptic's check"):
//  15. a write that reaches a leader in the middle of a transfer wakes its group and counts as a write for the quiet
//      rule (DESIGN-V5 4.2: "any write wakes it"); before, it was queued without a wake, so in a quiet group with a
//      stuck transfer it waited until the taker came back. Not hit in any earlier measured run (no taker died there)
//  16. the client learns which writes waited: an ack or a `moved` answer for a write that waited carries 0x100 in
//      its last field (the leader's id stays in the low byte)
//  17. `xferstat`: groups this member leads with a transfer set (Raft's leadTransferee), how many of them are quiet,
//      and to whom; `wakexfer`: a write arrives at every such group (patch 15's wake, nothing proposed)
//  18. xferawake=1 (off by default, so the design's quiet rule runs as written): a leader with a transfer in flight
//      does not let its group go quiet, so Raft's own abort (election.ms of ticks) can fire
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'E26-dormant-groups', 'host.ts');
const PORT = path.join(HERE, '..', 'E10-raft-port', 'port', 'src', 'index.ts');

export function patchHost(out) {
  let s = fs.readFileSync(SRC, 'utf8');
  const once = (from, to, what) => { const n = s.split(from).length - 1; if (n !== 1) throw new Error(`patch ${what}: ${n} matches`); s = s.replace(from, () => to); };
  // ---- E-49's four patches (boot.mjs), unchanged
  once("discardLogger, pb } from '../E10-raft-port/port/src/index.ts';", `discardLogger, pb, globalRand } from '${PORT}';   // E-49 patch 1`, 'import');
  once("const ID: number = a.id,", "if (a.jitter !== undefined) { const J = Number(a.jitter); globalRand.Intn = () => Math.floor(Math.random() * (J + 1)); }   // E-49 patch 2\nconst ID: number = a.id,", 'jitter');
  once("  for (let g = 0; g < N; g++) if (g % NP === ID - 1 && !a.boot) {", "  if (a.start !== 'random') for (let g = 0; g < N; g++) if (g % NP === ID - 1 && !a.boot) {   // E-49 patch 3\n", 'start');
  once("  } else if (cmd === 'mem') {", `  } else if (cmd === 'leaders') {   // E-49 patch 4
    let led = 0, pref = 0, prefLed = 0; const terms: Record<number, number> = {};
    for (let g = 0; g < groups.length; g++) { const gr = groups[g]; if (!gr) continue; const mine = g % NP === ID - 1; if (mine) pref++;
      if (gr.rn.raft.state === StateLeader) { led++; if (mine) prefLed++; const t = gr.rn.raft.Term; terms[t] = (terms[t] ?? 0) + 1; } }
    console.log(JSON.stringify({ ok: 'leaders', id: ID, led, pref, pref_led: prefLed, terms, ready_ms: +readyMs.toFixed(0) }));
  } else if (cmd === 'mem') {`, 'leaders');

  // ---- E-53 patch 13 (added after a crash in a timed run, see README): a probe that falls back to the founding
  // snapshot (index 1, the state every replica starts from; nothing is compacted here) is sent, not refused; the
  // follower already holds it and answers with its commit offset, as etcd raft does. Counted (ctr.snap).
  once("  if (m.Snapshot && m.Snapshot.Metadata && (m.Snapshot.Metadata.Index ?? 0) > 0) throw new Error('snapshots are not sent in E-11');\n  need(2); wb[wp++] = m.Type ?? 0; wb[wp++] = (m.Reject ? 1 : 0) | (m.Context ? 2 : 0);",
       "  const snap = m.Snapshot && m.Snapshot.Metadata && (m.Snapshot.Metadata.Index ?? 0) > 0 ? m.Snapshot.Metadata : null;   // E-53 patch 13\n  if (snap) ctr.snap++;\n  need(2); wb[wp++] = m.Type ?? 0; wb[wp++] = (m.Reject ? 1 : 0) | (m.Context ? 2 : 0) | (snap ? 4 : 0);", 'snap encode');
  once("  if (m.Context) bytes(m.Context);", "  if (m.Context) bytes(m.Context);\n  if (snap) { vu(snap.Index ?? 0); vu(snap.Term ?? 0); }   // E-53 patch 13", 'snap encode tail');
  once("  if (fl & 2) m.Context = new Uint8Array(rbytes());", "  if (fl & 2) m.Context = new Uint8Array(rbytes());\n  if (fl & 4) { const Index = ru(), Term = ru(); m.Snapshot = new pb.Snapshot({ Metadata: new pb.SnapshotMetadata({ Index, Term, ConfState: new pb.ConfState({ Voters: voters }) }) }); }   // E-53 patch 13", 'snap decode');

  // ---- E-53 patch 14 (added after the liveness check crashed a host, see README): dialling a dead peer's port again
  // and again can connect a socket to itself (Linux allows a TCP self-connect when the port is in the ephemeral range);
  // such a socket is dropped and the dial tried again
  once("c.once('connect', () => res(c));", "c.once('connect', () => { if (c.localPort === c.remotePort) { c.destroy(); setTimeout(go, 20); return; } res(c); /* E-53 patch 14 */ });", 'self-connect at start');

  // ---- E-53 patch 5: restart from the journal
  once("for (let g = 0; g < N; g++) makeGroup(g);", `// E-53 patch 5: restore=1 rebuilds each group from this process's journal (tagged records, replayed in order)
function restoreGroups() {
  const buf = fs.readFileSync(\`\${a.dir}/journal-\${ID}\`);
  const hs: any[] = new Array(N).fill(null), ents: pb.Entry[][] = new Array(N);
  rb = buf; rp = 0; let recs = 0, last = 0;
  while (rp < buf.length) {
    last = rp; const t = ru(), g = ru();
    if (t === 1) { const Term = ru(), Vote = ru(), Commit = ru(); if (rp > buf.length) break; hs[g] = { Term, Vote, Commit }; }
    else if (t === 2) { const Term = ru(), Index = ru(); const d = rbytes(); if (rp > buf.length) break;
      let l = ents[g]; if (!l) l = ents[g] = []; while (l.length && (l[l.length - 1].Index ?? 0) >= Index) l.pop();
      l.push(new pb.Entry({ Term, Index, Type: pb.EntryNormal, Data: d.length ? new Uint8Array(d) : undefined })); }
    else throw new Error('bad journal record type ' + t + ' at ' + last);
    recs++;
  }
  for (let g = 0; g < N; g++) {
    const st = new MemoryStorage();
    st.ApplySnapshot(new pb.Snapshot({ Metadata: new pb.SnapshotMetadata({ Index: 1, Term: 1, ConfState: new pb.ConfState({ Voters: voters }) }) }));
    const es = (ents[g] ?? []).filter((e) => (e.Index ?? 0) > 1); if (es.length) st.Append(es);
    let applied = 1; if (hs[g]) { st.SetHardState(new pb.HardState(hs[g])); applied = Math.max(1, Math.min(hs[g].Commit, st.LastIndex()[0])); }
    const rn = new RawNode(new Config({ ID, ElectionTick: a.elect, HeartbeatTick: 1, Storage: st, Applied: applied, MaxSizePerMsg: 1 << 20, MaxInflightMsgs: 256, PreVote: true, CheckQuorum: true, Logger: discardLogger }));
    groups[g] = { rn, st, quiet: false, active: true, idle: 0, proposed: false, dirty: false };
    active.push(g); awakeCount++;
  }
  return recs;
}
const restoredRecs = a.restore ? restoreGroups() : 0;
if (!a.restore) for (let g = 0; g < N; g++) makeGroup(g);
// E-53 patch 7: counters on the Raft object's own steps (one wrapper on the shared prototype, not per group)
const ctr: Record<string, number> = { pre: 0, cand: 0, xfer: 0, lead: 0, snap: 0 };
{ const RP: any = Object.getPrototypeOf(groups[0]!.rn.raft);
  for (const [k, f] of [['becomePreCandidate', 'pre'], ['becomeCandidate', 'cand'], ['becomeLeader', 'lead']]) { const o = RP[k]; RP[k] = function (this: any, ...x: any[]) { ctr[f]++; return o.apply(this, x); }; }
  const oh = RP.hup; RP.hup = function (this: any, t: string) { if (t === 'CampaignTransfer') ctr.xfer++; return oh.call(this, t); }; }`, 'restore');
  once("const jfd = fs.openSync(`${a.dir}/journal-${ID}`, 'w');", "const jfd = fs.openSync(`${a.dir}/journal-${ID}`, a.restore ? 'a' : 'w');   // E-53 patch 5", 'journal open');
  once("vu(g); vu(rd.HardState!.Term ?? 0);", "vu(1); vu(g); vu(rd.HardState!.Term ?? 0);", 'journal hs tag');
  once("for (const e of rd.Entries) { vu(g); vu(e.Term ?? 0);", "for (const e of rd.Entries) { vu(2); vu(g); vu(e.Term ?? 0);", 'journal entry tag');

  // ---- E-53 patch 6: links that die and come back
  once("function flush(p: number, ping: boolean) {", "function flush(p: number, ping: boolean) {\n  if (!peers[p]) { out[p] = []; outCount[p] = 0; return; }   // E-53 patch 6: a dead link drops its frames", 'flush guard');
  once("const p = h.readUInt32LE(0) - 1; peers[p] = s; lastSent[p] = performance.now(); reader(s); s.resume();",
       "const p = h.readUInt32LE(0) - 1; peers[p] = s; lastSent[p] = performance.now(); reader(s); s.resume(); linkUp(p, s);   // E-53 patch 6", 'incoming link');
  once("peers[p - 1] = s; lastSent[p - 1] = performance.now(); reader(s);", "peers[p - 1] = s; lastSent[p - 1] = performance.now(); reader(s); linkUp(p - 1, s);   // E-53 patch 6", 'outgoing link');
  // E-53 patch 18 (after the skeptic's check): xferawake=1 keeps a group with a transfer in flight awake
  once("    if (a.mode === 'quiet' && gr.rn.raft.state === StateLeader) {",
       "    if (a.mode === 'quiet' && gr.rn.raft.state === StateLeader && !(a.xferawake && gr.rn.raft.leadTransferee !== 0)) {   // E-53 patch 18", 'quiet xferawake');
  // a quiet leader counts only the voters whose link is up (DESIGN-V5 4.2: "whose live voters have all reached its commit offset")
  once("for (const pr of gr.rn.raft.trk.Progress.values()) if (pr.Match !== commit) { matched = false; break; }",
       "for (const [pid, pr] of gr.rn.raft.trk.Progress) if (pr.Match !== commit && (pid === ID || peers[pid - 1])) { matched = false; break; }   // E-53 patch 6", 'quiet live voters');

  // ---- E-53 patch 8: committed client writes are answered where they were proposed
  once("    const d = e.Data;", "    const d = e.Data;\n    if ((e.Type ?? 0) === pb.EntryNormal && d && d.length >= 9 && d[0] === 0xc1) { onClientApply(d); continue; }   // E-53 patch 8", 'apply');
  // ---- E-53 patch 12: the hand-back's checks
  once("    firstWrites();\n  }", "    firstWrites(); hbAfter(rds);   // E-53 patch 12\n  }\n  cflush();", 'after round');
  once("function tick() {", "function tick() {\n  hbTick();   // E-53 patch 12", 'tick');
  once("  setInterval(tick, a.tick);", "  setInterval(tick, a.tick);\n  if (a.cport) startClientServer();   // E-53 patch 8", 'client server');

  // ---- E-53 patches 10 and 11: commands
  once("  } else if (cmd === 'stats') {", `  } else if (cmd === 'handback') {   // E-53 patch 10
    const kv: any = Object.fromEntries(l.trim().split(/\\s+/).slice(1).map((x) => x.split('=')));
    hbStart(kv);
  } else if (cmd === 'hbstat') {   // E-53 patch 11
    let led = 0, pref = 0, prefLed = 0, awake = 0, terms = 0, nolead = 0;
    for (let g = 0; g < groups.length; g++) { const gr = groups[g]; if (!gr) continue; const mine = g % NP === ID - 1; if (mine) pref++;
      if (gr.rn.raft.state === StateLeader) { led++; if (mine) prefLed++; } if (!gr.quiet) awake++; if (gr.rn.raft.lead === 0) nolead++; terms += gr.rn.raft.Term; }
    console.log(JSON.stringify({ ok: 'hbstat', id: ID, led, pref, pref_led: prefLed, awake, nolead, terms, ctr, pending: pending.size, waiting: waitq.size, cmoved, cwaited, restored_recs: restoredRecs, hb_inflight: hb ? hb.inflight.size : 0, hb_fails: hb ? hb.fails : 0, ready_ms: +readyMs.toFixed(0), t_wall: wall() }));
  } else if (cmd === 'xferstat') {   // E-53 patch 17: led groups with a transfer set, how many quiet, to whom
    let xfer = 0, xq = 0; const to: Record<number, number> = {};
    for (let g = 0; g < groups.length; g++) { const gr = groups[g]; if (!gr || gr.rn.raft.state !== StateLeader || gr.rn.raft.leadTransferee === 0) continue;
      xfer++; if (gr.quiet) xq++; const t = gr.rn.raft.leadTransferee; to[t] = (to[t] ?? 0) + 1; }
    console.log(JSON.stringify({ ok: 'xferstat', id: ID, xfer, quiet: xq, to, hb_inflight: hb ? hb.inflight.size : 0, waiting: waitq.size, xferawake: !!a.xferawake, t_wall: wall() }));
  } else if (cmd === 'wakexfer') {   // E-53 patch 17: a write arrives at every led group with a transfer set (patch 15's wake)
    let n = 0;
    for (let g = 0; g < groups.length; g++) { const gr = groups[g]; if (!gr || gr.rn.raft.state !== StateLeader || gr.rn.raft.leadTransferee === 0) continue;
      wake(g); gr.proposed = true; mark(g); n++; }
    schedule(); console.log(JSON.stringify({ ok: 'wakexfer', id: ID, n, t_wall: wall() }));
  } else if (cmd === 'stats') {`, 'commands');

  // ---- E-53 patches 6, 8, 9, 10: the code they call
  once("// ---------------------------------------------------------------- the loop", `// ---------------------------------------------------------------- E-53: links, client writes, the hand-back
// patch 6: links
function linkDown(p: number, s: net.Socket) {
  if (peers[p] !== s) return;
  peers[p] = null; out[p] = []; outCount[p] = 0;
  for (let g = 0; g < groups.length; g++) { const gr = groups[g]; if (gr && gr.rn.raft.lead === p + 1) { wake(g); mark(g); } }   // its followers elect after election.ms
  if (p > ID - 1) redial(p);   // the lower id dials
}
function linkUp(p: number, s: net.Socket) {
  s.removeAllListeners('error'); s.on('error', () => {}); s.on('close', () => linkDown(p, s));   // the dial's own retry listener goes
  for (let g = 0; g < groups.length; g++) { const gr = groups[g]; if (gr && gr.rn.raft.state === StateLeader) { wake(g); mark(g); } }   // heartbeats tell the peer who leads, and catch it up
}
function redial(p: number) {
  const c = net.connect(PORTS[p], '127.0.0.1');
  c.once('connect', () => { if (c.localPort === PORTS[p]) { c.destroy(); setTimeout(() => redial(p), 50); return; }   // patch 14: a TCP self-connect to a dead peer's port
    c.setNoDelay(true); const h = Buffer.allocUnsafe(4); h.writeUInt32LE(ID); c.write(h); peers[p] = c; lastSent[p] = performance.now(); reader(c); linkUp(p, c); });
  c.once('error', () => { c.destroy(); setTimeout(() => redial(p), 50); });
}
// patch 8: client writes
let csock: net.Socket | null = null; const cout: Buffer[] = [];
const pending = new Set<number>(); const waitq = new Map<number, { to: number; seqs: number[] }>();
let cmoved = 0, cwaited = 0;
const WAITED = 0x100;   // patch 16: the reply's last field carries this bit for a write that waited for a transfer
const waitedSeqs = new Set<number>();
function creply(type: number, g: number, seq: number, x: number) { const b = Buffer.allocUnsafe(13); b[0] = type; b.writeUInt32LE(g >>> 0, 1); b.writeUInt32LE(seq >>> 0, 5); b.writeUInt32LE(x >>> 0, 9); cout.push(b); }
function cflush() { if (cout.length && csock) csock.write(cout.length === 1 ? cout[0] : Buffer.concat(cout)); cout.length = 0; }
function cpropose(g: number, gr: G, seq: number, waited = false) {
  const d = Buffer.alloc(a.size); d[0] = 0xc1; d.writeUInt32LE(g, 1); d.writeUInt32LE(seq, 5);
  wake(g); gr.proposed = true;
  if (gr.rn.Propose(new Uint8Array(d.buffer, d.byteOffset, d.length)) !== null) { cmoved++; creply(3, g, seq, (gr.rn.raft.lead === ID ? 0 : gr.rn.raft.lead) | (waited ? WAITED : 0)); return; }
  const k = g * 4294967296 + seq; pending.add(k); if (waited) waitedSeqs.add(k); mark(g);
}
function onClientWrite(g: number, seq: number) {
  const gr = groups[g];
  if (!gr || gr.rn.raft.state !== StateLeader) { cmoved++; creply(3, g, seq, gr ? gr.rn.raft.lead : 0); return; }
  const to = gr.rn.raft.leadTransferee;
  if (to !== 0) { let q = waitq.get(g); if (!q) waitq.set(g, q = { to, seqs: [] }); q.seqs.push(seq); cwaited++;
    wake(g); gr.proposed = true; mark(g);   // patch 15: any write wakes its group
    return; }   // waits for the handover
  cpropose(g, gr, seq);
}
function releaseWaiting() {
  for (const [g, q] of waitq) {
    const gr = groups[g];
    if (!gr || gr.rn.raft.state !== StateLeader) { const hint = gr && gr.rn.raft.lead ? gr.rn.raft.lead : q.to; for (const s of q.seqs) { cmoved++; creply(3, g, s, hint | WAITED); } waitq.delete(g); }
    else if (gr.rn.raft.leadTransferee === 0) { waitq.delete(g); for (const s of q.seqs) cpropose(g, gr, s, true); }   // the transfer was abandoned: propose them here
  }
}
function onClientApply(d: Uint8Array) {
  const b = Buffer.from(d.buffer, d.byteOffset, d.length); const g = b.readUInt32LE(1), seq = b.readUInt32LE(5);
  recent[g]++;   // patch 9
  const k = g * 4294967296 + seq;
  if (pending.delete(k)) creply(2, g, seq, waitedSeqs.delete(k) ? WAITED : 0);
}
function startClientServer() {
  const srv = net.createServer({ noDelay: true }, (s) => {
    s.setNoDelay(true); csock = s; s.on('error', () => {}); s.on('close', () => { if (csock === s) csock = null; });
    let buf = Buffer.alloc(0);
    s.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk; let off = 0;
      while (buf.length - off >= 13) { onClientWrite(buf.readUInt32LE(off + 1), buf.readUInt32LE(off + 5)); off += 13; }
      buf = off === buf.length ? Buffer.alloc(0) : buf.subarray(off); cflush();
    });
  });
  srv.listen(Number(a.cport), '127.0.0.1');
}
// patch 9: recent writes per group
const recent = new Float64Array(a.max); let decayTicks = 0;
// patch 10: the hand-back, pulled by each preferred member
let hb: any = null;
function shuffle(x: number[]) { for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = x[i]; x[i] = x[j]; x[j] = t; } return x; }
function hbStart(kv: any) {
  const now = performance.now(); const list: number[] = []; let pref = 0, have = 0;
  for (let g = 0; g < groups.length; g++) { const gr = groups[g]; if (!gr || g % NP !== ID - 1) continue; pref++; if (gr.rn.raft.state === StateLeader) have++; else list.push(g); }
  shuffle(list); if (kv.order === 'busy') list.sort((x, y) => recent[y] - recent[x]);   // stable: ties stay shuffled
  hb = { cap: Number(kv.cap || 0), rate: Number(kv.rate || 0), max: Number(kv.max || 0) * 1000, timeout: Number(kv.timeout || 3000), order: kv.order || 'random',
    t0: now, w0: wall(), list, cand: list.length, busy: list.filter((g) => recent[g] > 0.5).length, next: 0, inflight: new Map<number, number>(), late: new Map<number, number>(),
    started: 0, ok: 0, okLate: 0, fails: 0, noLead: 0, pref, have0: have, ev: [] as number[], done: false, stopped: false };
  hbPump();
}
function hbComplete(g: number, t0: number, late: boolean) {
  const now = performance.now(); if (late) hb.okLate++; else hb.ok++;
  hb.ev.push(g, +(t0 - hb.t0).toFixed(1), +(now - hb.t0).toFixed(1), late ? 1 : 0);
}
function hbPump() {
  if (!hb || hb.done) return;
  const now = performance.now();
  if (hb.max && now - hb.t0 > hb.max) hb.stopped = true;
  if (!hb.stopped) {
    let allow = hb.cap > 0 ? hb.cap - hb.inflight.size : Math.floor((now - hb.t0) * hb.rate / 1000) + 1 - hb.started;
    let guard = hb.list.length - hb.next;
    while (allow > 0 && hb.next < hb.list.length && guard-- > 0) {
      const g = hb.list[hb.next++]; const gr = groups[g]; if (!gr || gr.rn.raft.state === StateLeader) continue;
      if (gr.rn.raft.lead === 0) { hb.noLead++; hb.list.push(g); continue; }   // no leader known yet: try it later
      hb.late.delete(g); gr.rn.TransferLeader(ID); mark(g); hb.inflight.set(g, now); hb.started++; allow--;
    }
  }
  if (!hb.inflight.size && (hb.stopped || hb.next >= hb.list.length)) hbDone();
}
function hbAfter(rds: [number, any][]) {
  if (waitq.size) releaseWaiting();
  if (!hb || hb.done) return;
  for (const [g] of rds) {
    const gr = groups[g]; if (!gr || gr.rn.raft.state !== StateLeader) continue;
    const t = hb.inflight.get(g); if (t !== undefined) { hb.inflight.delete(g); hbComplete(g, t, false); continue; }
    const tl = hb.late.get(g); if (tl !== undefined) { hb.late.delete(g); hbComplete(g, tl, true); }
  }
  hbPump();
}
function hbTick() {
  if (++decayTicks >= Math.round(1000 / a.tick)) { decayTicks = 0; for (let g = 0; g < recent.length; g++) if (recent[g]) recent[g] *= 0.5; }
  if (waitq.size) { releaseWaiting(); cflush(); }
  if (!hb || hb.done) return;
  const now = performance.now();
  for (const [g, t] of hb.inflight) if (now - t > hb.timeout) { hb.inflight.delete(g); hb.fails++; hb.late.set(g, t); hb.list.push(g); }
  hbPump();
}
function hbDone() {
  hb.done = true; let prefLed = 0;
  for (let g = 0; g < groups.length; g++) { const gr = groups[g]; if (gr && g % NP === ID - 1 && gr.rn.raft.state === StateLeader) prefLed++; }
  console.log(JSON.stringify({ ok: 'handback', id: ID, pace: hb.cap ? 'cap' : 'rate', cap: hb.cap, rate: hb.rate, order: hb.order, pref: hb.pref, have0: hb.have0, cand: hb.cand, busy: hb.busy,
    started: hb.started, n_ok: hb.ok, ok_late: hb.okLate, fails: hb.fails, no_lead: hb.noLead, stopped: hb.stopped, pref_led_end: prefLed,
    ms: +(performance.now() - hb.t0).toFixed(1), w0: hb.w0, ev: hb.ev }));
}

// ---------------------------------------------------------------- the loop`, 'e53 block');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, s);
  return out;
}
