// E-49 disk: bytes, files, inodes and open files per resource, for two segment layouts, and the one-box genesis.
//   node disk.mjs layout=files R=<n>     a folder per group with its own segment and index file (L0's "one set
//                                        of files per group", LAYERS 1.2): create, bytes on disk, inodes, opening
//                                        every segment at boot, holding them open, removing
//   node disk.mjs layout=shared R=<n>    every group's founding records in one shared segment and one index
//   node disk.mjs genesis n=200          the one-box genesis (E-33, LAYERS 1.6): an exclusive create of the
//                                        resource's id file, write, fdatasync, fsync of the folder; and the same
//                                        with a group folder and its two files made and synced
// Each group starts with its founding batch (settings, slot table, group record, and Raft's entry framing):
// FOUND bytes in its segment, 16 index bytes. Bytes on disk are the files' allocated blocks (st_blocks x 512).
import fs from 'node:fs';
import path from 'node:path';
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const ROOT = path.join(SP, 'e49', 'disk');
const FOUND = 224, IDX = 16;
const seg = Buffer.alloc(FOUND, 0x61), idx = Buffer.alloc(IDX, 0x69);
const meminfo = (k) => Number(fs.readFileSync('/proc/meminfo', 'utf8').match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'))[1]);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); };
const out = (o) => console.log(JSON.stringify({ exp: 'E-49', part: 'disk', loadavg: fs.readFileSync('/proc/loadavg', 'utf8').trim(), ...o }));
fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true });

if (args.layout === 'files') {
  const R = Number(args.R);
  let t = performance.now();
  for (let g = 0; g < R; g++) {
    const d = path.join(ROOT, 'g' + g); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'seg-0'), seg); fs.writeFileSync(path.join(d, 'idx-0'), idx);
  }
  const create_ms = performance.now() - t;
  let blocks = 0; for (let g = 0; g < R; g++) for (const f of ['seg-0', 'idx-0']) blocks += fs.statSync(path.join(ROOT, 'g' + g, f)).blocks;
  const dirBlocks = R * fs.statSync(path.join(ROOT, 'g0')).blocks;
  // boot: open and read every group's segment once (a restart that opens each group's files), then close
  t = performance.now();
  const b = Buffer.alloc(FOUND);
  for (let g = 0; g < R; g++) { const fd = fs.openSync(path.join(ROOT, 'g' + g, 'seg-0'), 'r'); fs.readSync(fd, b, 0, FOUND, 0); fs.closeSync(fd); }
  const open_read_close_ms = performance.now() - t;
  // holding segments open, as a store that keeps each group's active segment open: up to what this box allows
  const limit = 19000, H = Math.min(R, limit);
  const slab0 = meminfo('Slab'), rss0 = process.memoryUsage().rss; const fds = [];
  t = performance.now();
  try { for (let g = 0; g < H; g++) fds.push(fs.openSync(path.join(ROOT, 'g' + g, 'seg-0'), 'r')); } catch (e) { fds.err = e.code; }
  const hold_ms = performance.now() - t;
  const slab1 = meminfo('Slab'), rss1 = process.memoryUsage().rss;
  for (const fd of fds) fs.closeSync(fd);
  t = performance.now(); fs.rmSync(ROOT, { recursive: true, force: true }); const rm_ms = performance.now() - t;
  out({ layout: 'files', R, files: 2 * R, dirs: R, inodes: 3 * R, payload_B: R * (FOUND + IDX), allocated_B: blocks * 512, dir_allocated_B: dirBlocks * 512,
    allocated_per_res_B: Math.round((blocks + dirBlocks) * 512 / R), create_ms: +create_ms.toFixed(1), create_us_per_res: +(create_ms * 1000 / R).toFixed(1),
    open_read_close_us_per_res: +(open_read_close_ms * 1000 / R).toFixed(2), held_open: fds.length, hold_err: fds.err ?? null, hold_open_us: +(hold_ms * 1000 / Math.max(1, fds.length)).toFixed(2),
    kernel_slab_per_open_B: fds.length ? Math.round((slab1 - slab0) * 1024 / fds.length) : null, rss_per_open_B: fds.length ? Math.round((rss1 - rss0) / fds.length) : null,
    fd_soft_limit: limit + 1000, rm_ms: +rm_ms.toFixed(1) });
} else if (args.layout === 'shared') {
  const R = Number(args.R);
  let t = performance.now();
  const sfd = fs.openSync(path.join(ROOT, 'seg-0'), 'w'), ifd = fs.openSync(path.join(ROOT, 'idx-0'), 'w');
  // founding batches arrive one at a time; each is appended to the shared segment (the journal's segments) and indexed
  for (let g = 0; g < R; g++) { fs.writeSync(sfd, seg); fs.writeSync(ifd, idx); }
  fs.closeSync(sfd); fs.closeSync(ifd);
  const create_ms = performance.now() - t;
  const blocks = fs.statSync(path.join(ROOT, 'seg-0')).blocks + fs.statSync(path.join(ROOT, 'idx-0')).blocks;
  t = performance.now(); const all = fs.readFileSync(path.join(ROOT, 'seg-0')); fs.readFileSync(path.join(ROOT, 'idx-0')); const read_ms = performance.now() - t;
  fs.rmSync(ROOT, { recursive: true, force: true });
  out({ layout: 'shared', R, files: 2, payload_B: R * (FOUND + IDX), allocated_B: blocks * 512, allocated_per_res_B: Math.round(blocks * 512 / R),
    create_us_per_res: +(create_ms * 1000 / R).toFixed(2), read_all_ms: +read_ms.toFixed(2), read_B: all.length });
} else if (args.layout === 'genesis') {
  const n = Number(args.n || 200);
  const ex = [], exNoDir = [], grp = [];
  const dfd = fs.openSync(ROOT, 'r');
  for (let i = 0; i < n; i++) {
    let t = performance.now();
    const fd = fs.openSync(path.join(ROOT, 'res-' + i), 'wx'); fs.writeSync(fd, Buffer.alloc(64, 1)); fs.fdatasyncSync(fd); fs.closeSync(fd); fs.fsyncSync(dfd);
    ex.push(performance.now() - t);
    t = performance.now();
    const fd2 = fs.openSync(path.join(ROOT, 'rnd-' + i), 'wx'); fs.writeSync(fd2, Buffer.alloc(64, 1)); fs.fdatasyncSync(fd2); fs.closeSync(fd2);
    exNoDir.push(performance.now() - t);
    // the group-per-files form also makes the group's folder and two files durable before the group can answer
    t = performance.now();
    const d = path.join(ROOT, 'g' + i); fs.mkdirSync(d); const gd = fs.openSync(d, 'r');
    for (const [f, b] of [['seg-0', seg], ['idx-0', idx]]) { const fd3 = fs.openSync(path.join(d, f), 'wx'); fs.writeSync(fd3, b); fs.fdatasyncSync(fd3); fs.closeSync(fd3); }
    fs.fsyncSync(gd); fs.closeSync(gd); fs.fsyncSync(dfd);
    grp.push(performance.now() - t);
  }
  fs.closeSync(dfd);
  // a second try of an existing id is refused (create-if-absent)
  let refused = false; try { fs.openSync(path.join(ROOT, 'res-0'), 'wx'); } catch (e) { refused = e.code === 'EEXIST'; }
  fs.rmSync(ROOT, { recursive: true, force: true });
  out({ layout: 'genesis', n, excl_create_fsync_dirsync_ms: { p50: q(ex, 0.5), p90: q(ex, 0.9), p99: q(ex, 0.99) }, excl_create_fsync_ms: { p50: q(exNoDir, 0.5), p99: q(exNoDir, 0.99) },
    group_files_synced_ms: { p50: q(grp, 0.5), p90: q(grp, 0.9), p99: q(grp, 0.99) }, second_create_refused: refused });
} else throw new Error('layout=files|shared|genesis');
