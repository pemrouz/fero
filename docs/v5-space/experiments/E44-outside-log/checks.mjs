// E-44: the acceptance checks of P-01, P-14, P-10 and P-09 (REQUIREMENTS §1), run against the BUY prototype on a
// three-server JetStream cluster, with the stream's leader killed in the middle where it matters.
//   node checks.mjs p01|p14|p10|p09|dedup
// Each check prints JSON lines: { check, ok, ...numbers }. "ok: false" on a line whose name starts with "gap:" is a
// requirement BUY does not meet; any other "ok: false" is a failed check.
import { execFileSync } from 'node:child_process'
import { open, fero, lock, queue } from './buy.mjs'
const HERE = new URL('.', import.meta.url).pathname
const S = process.env.E44_SERVERS.split(',')
const WHAT = process.argv[2], RUN = process.env.E44_RUN ?? String(Date.now() % 100000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (o) => console.log(JSON.stringify(o))
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null }
const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]))
const leaderOf = async (ctx, stream) => (await ctx.jsm.streams.info(stream)).cluster.leader
// kill -9 the server that leads a stream, bring it back 1.5 s later
const killLeader = async (ctx, stream) => { const l = await leaderOf(ctx, stream); const n = l.slice(1); execFileSync(HERE + 'cluster.sh', ['kill', n]); setTimeout(() => execFileSync(HERE + 'cluster.sh', ['start', n], { stdio: 'ignore' }), 1500); return l }
const clients = async (n) => Promise.all(Array.from({ length: n }, (_, i) => open([S[i % 3], S[(i + 1) % 3], S[(i + 2) % 3]], 'c' + i)))

if (WHAT === 'p01') {
  const cs = await clients(3), name = 'shop' + RUN
  const rs = []; for (const c of cs) rs.push(await fero(c, name))
  let seenByA = 0; rs[0].data.sink({ apply() { seenByA++ } })                 // a live subscriber on client A
  const acks = [], lat = []; let ryw = 0, rywBad = 0, dup = 0, killed = null
  const work = (r, who) => (async () => {
    for (let i = 0; i < 300; i++) {
      const key = 'k' + Math.floor(Math.random() * 50), row = { by: who, i }
      const t = performance.now(); const a = await r.set(key, row); lat.push(performance.now() - t)
      if (a.duplicate) dup++
      acks.push({ key, version: a.version, row })
      // read your writes: the own snapshot holds the row, unless a later write to that key was folded since
      const now = r.snapshot[key]; ryw++; if (!(now && ((now.by === who && now.i === i) || r.applied > a.version))) rywBad++
      if (who === 0 && i === 100) killed = await killLeader(cs[0], 'FERO_' + name)
    }
  })()
  await Promise.all(rs.map((r, i) => work(r, i)))
  const last = (await cs[0].jsm.streams.info('FERO_' + name)).state.last_seq
  for (let t = 0; t < 200 && rs.some((r) => r.applied < last); t++) await sleep(50)
  const fresh = await fero(await open(S, 'fresh'), name)                     // a new client folds the stream from the start
  const snaps = [...rs, fresh].map((r) => canon(r.snapshot))
  const want = {}; for (const a of acks.sort((x, y) => x.version - y.version)) want[a.key] = a.row
  out({ check: 'P-01 every client folds to the same rows, and a new client too', ok: snaps.every((s) => s === snaps[0]), rows: Object.keys(rs[0].snapshot).length })
  out({ check: 'P-01 no acknowledged write lost across a leader kill (' + killed + ')', ok: canon(want) === snaps[0], writes: acks.length, duplicatesStoppedByMsgId: dup })
  out({ check: 'P-01 read your writes', ok: rywBad === 0, checked: ryw })
  out({ check: 'P-01 others\' changes arrive live', ok: seenByA >= 600, commitsSeenByClientA: seenByA })
  out({ check: 'P-01 write latency through BUY (rough, box shared; one fsync per message on 3 servers)', ok: true, p50ms: pct(lat, 0.5), p99ms: pct(lat, 0.99), maxMs: pct(lat, 1) })
  const t0 = process.hrtime.bigint(); let x = 0; for (let i = 0; i < 1e6; i++) x += rs[0].snapshot.k1 ? 1 : 0; const snapNs = Number(process.hrtime.bigint() - t0) / 1e6
  const held = rs[0].data; const t1 = process.hrtime.bigint(); for (let i = 0; i < 1e6; i++) x += held.k1 ? 1 : 0; const heldNs = Number(process.hrtime.bigint() - t1) / 1e6
  out({ check: 'P-01 a held-row read is a local read (no round trip)', ok: true, nsPerReadThroughSnapshot: +snapNs.toFixed(0), nsPerReadThroughHandle: +heldNs.toFixed(0) })
  for (const c of cs) await c.nc.close()
  process.exit(0)
}

if (WHAT === 'p14') {
  const cs = await clients(8), name = 'stock' + RUN
  const rs = []; for (const c of cs) rs.push(await fero(c, name))
  // two sells of the last item through two servers: exactly one ok
  let exactlyOne = 0, rounds = 100
  for (let i = 0; i < rounds; i++) {
    await rs[0].set('sku' + i, { left: 1, price: 5 })
    const [a, b] = await Promise.all([rs[1].incr('sku' + i, 'left', -1, { min: 0 }), rs[2].incr('sku' + i, 'left', -1, { min: 0 })])
    const left = (await rs[0].get('sku' + i)).value.left
    if (a.ok !== b.ok && left === 0 && (a.ok ? b.why : a.why) === 'bounds') exactlyOne++
  }
  out({ check: 'P-14 two sells of the last item through two servers: exactly one ok', ok: exactlyOne === rounds, rounds, exactlyOne })
  // eight clients, 50 decrements each, 100 in stock, a leader kill in the middle
  await rs[0].set('hot', { left: 100 })
  let oks = 0, refused = 0, retries = 0, killed = null
  const t0 = Date.now()
  await Promise.all(rs.map((r, w) => (async () => { for (let i = 0; i < 50; i++) { const a = await r.incr('hot', 'left', -1, { min: 0 }); retries += a.retries; if (a.ok) oks++; else refused++; if (w === 0 && i === 10) killed = await killLeader(cs[0], 'FERO_' + name) } })()))
  const ms8 = Date.now() - t0, left = (await rs[0].get('hot')).value.left
  out({ check: 'P-14 bounds hold under 8 writers and a leader kill (' + killed + '): 100 ok, 300 refused, 0 left', ok: oks === 100 && refused === 300 && left === 0, oks, refused, left, checkAndWriteRetries: retries, ms: ms8 })
  await sleep(6000)                                                          // let the killed server come back and catch up
  // the price of the retry loop: the same 100 decrements from one client, then from 8 at once (no kill)
  await rs[0].set('solo', { left: 1e6 }); const t1 = Date.now(); for (let i = 0; i < 100; i++) await rs[0].incr('solo', 'left', -1, { min: 0 }); const msSolo = Date.now() - t1
  await rs[0].set('crowd', { left: 1e6 }); let r8 = 0; const t2 = Date.now()
  await Promise.all(rs.map((r) => (async () => { for (let i = 0; i < 25; i++) r8 += (await r.incr('crowd', 'left', -1, { min: 0 })).retries })()))
  const msCrowd = Date.now() - t2
  out({ check: 'P-14 cost of judging at the client (rough): 200 decrements of one row', ok: true, oneClient100: { ms: msSolo, publishes: 100 }, eightClients200: { ms: msCrowd, publishes: 200 + r8, retries: r8, wastedShare: +(r8 / (200 + r8)).toFixed(2) } })
  // a refusal says why and never commits later
  const rr = await rs[3].set('sku0', { left: 5, price: 6 }, { if: { version: 1 } }); await sleep(300)
  out({ check: 'P-14 a refused conditional write says why and never shows up', ok: rr.ok === false && rr.why === 'version' && rs[0].snapshot.sku0.left === 0, refusal: rr })
  // a condition over two rows of one partition cannot be said: the check is per subject (per row)
  out({ check: 'gap: P-14 a condition over more than one row (a partition of several rows)', ok: false, why: 'Nats-Expected-Last-Subject-Sequence checks one subject; 2.10 has no check over a subject set, so a partition must be one row, or the whole stream (Nats-Expected-Last-Sequence), which any other write breaks' })
  for (const c of cs) await c.nc.close()
  process.exit(0)
}

if (WHAT === 'p10') {
  const cs = await clients(4), LEASE = 1000
  // mutual exclusion and rising tokens, with a leader kill in the middle
  const events = [], fences = []; let killed = null
  await Promise.all(cs.map((c, w) => (async () => {
    for (let i = 0; i < 15; i++) {
      const l = await lock(c, 'payroll' + RUN, { leaseMs: LEASE, waitMs: 20000 })
      if (!l.ok) { events.push({ w, fail: l.why }); continue }
      events.push({ at: performance.now(), w, e: 'in', fence: l.fence }); fences.push(l.fence)
      await sleep(5 + Math.random() * 20)
      const still = l.held; events.push({ at: performance.now(), w, e: 'out', still })
      await l.release()
      if (w === 0 && i === 5) killed = await killLeader(c, 'LOCK_' + LEASE)
    }
  })()))
  let inside = 0, overlap = 0; for (const e of events.filter((e) => e.e).sort((a, b) => a.at - b.at)) { if (e.e === 'in') { if (inside > 0) overlap++; inside++ } else inside-- }
  const rising = fences.every((f, i) => i === 0 || f > fences[i - 1])
  out({ check: 'P-10 at most one holder at a time, 4 contenders, a leader kill (' + killed + ')', ok: overlap === 0 && events.filter((e) => e.fail).length === 0, acquires: fences.length, overlaps: overlap, gaveUp: events.filter((e) => e.fail).length })
  out({ check: 'P-10 tokens strictly rise in acquire order, across the failover', ok: rising, first: fences[0], last: fences[fences.length - 1] })
  // acquire time, nobody else waiting (rough)
  const lat = []; for (let i = 0; i < 30; i++) { const t = performance.now(); const l = await lock(cs[1], 'solo' + RUN + i, { leaseMs: LEASE }); lat.push(performance.now() - t); await l.release() }
  out({ check: 'P-10 acquire time, uncontended (rough; the bar is one commit)', ok: true, p50ms: pct(lat, 0.5), p99ms: pct(lat, 0.99) })
  // a paused holder (a long GC): its lease lapses by the server's clock, another takes the lock
  const ledger = await fero(cs[0], 'ledger' + RUN), ledgerB = await fero(cs[1], 'ledger' + RUN)
  const a = await lock(cs[0], 'pay' + RUN, { leaseMs: LEASE }); a.pause()
  const t0 = performance.now(); const b = await lock(cs[1], 'pay' + RUN, { leaseMs: LEASE, waitMs: 10000 }); const tookMs = performance.now() - t0
  const w1 = await ledger.set('run-41', { by: 'A' }, { if: { fence: a.fence } })       // B has not written this row yet: the stale holder gets in
  const w2 = await ledgerB.set('run-42', { by: 'B' }, { if: { fence: b.fence } })
  const w3 = await ledger.set('run-42', { by: 'A' }, { if: { fence: a.fence } })       // the row has seen B's token: refused
  out({ check: 'P-10 a second holder gets the lock after the first one stops, with a higher token', ok: b.ok && b.fence > a.fence, lapsedAfterMs: Math.round(tookMs), leaseMs: LEASE, fenceA: a.fence, fenceB: b.fence })
  out({ check: 'P-10 a write under an older token than the row has seen is refused', ok: w2.ok && w3.ok === false && w3.why === 'fenced', w3 })
  out({ check: 'P-10 (as designed) a stale holder may still write a row the new holder has not touched', ok: w1.ok === true, note: 'fencing is per protected row, as in the requirement ("older than one a writer has seen")' })
  const w4 = await ledger.set('run-42', { by: 'rogue' })                                // no token at all
  out({ check: 'gap: P-10 the token check is enforced for every writer', ok: !w4.ok, why: 'the check runs in the client library; a writer that leaves the token out (old code, another tool) is not refused: JetStream cannot tie a write to a token', unfencedWriteAccepted: w4.ok })
  // the same lock name under two lease lengths lives in two streams: two holders, unrelated tokens
  const x = await lock(cs[2], 'dual' + RUN, { leaseMs: 1000 }), y = await lock(cs[3], 'dual' + RUN, { leaseMs: 2000 })
  out({ check: 'gap: P-10 one lock name is one lock whatever its lease', ok: !(x.ok && y.ok), why: 'expiry is the stream\'s max age (2.10 has no per-message expiry), so each lease length needs its own stream, with its own sequence', bothHeld: x.ok && y.ok, fences: [x.fence, y.fence] })
  await x.release(); await y.release(); await b.release()
  for (const c of cs) await c.nc.close()
  process.exit(0)
}

if (WHAT === 'p09') {
  const cs = await clients(4), LEASE = 2500                                  // well above a take's own wait (1 s at most)
  const q = await queue(cs[0], 'thumbs' + RUN, { leaseMs: LEASE, deliveries: 3 })
  q.reap()
  let dups = 0; for (let i = 0; i < 300; i++) await q.add({ i }, { id: 'j' + i }); for (let i = 0; i < 300; i++) if ((await q.add({ i }, { id: 'j' + i })).duplicate) dups++
  out({ check: 'P-09 an enqueue retried with its id lands once (inside the dedup window)', ok: dups === 300 && (await q.depth()) === 300, duplicatesDropped: dups })
  const handed = new Map(), acked = new Map(), poison = (i) => i % 50 === 7, doubles = []; let doubleLease = 0, killed = null, killedAt = 0, takes = 0
  const qs = [q]; for (let w = 1; w < 4; w++) qs.push(await queue(cs[w], 'thumbs' + RUN, { leaseMs: LEASE, deliveries: 3 }))
  const t0 = Date.now()
  await Promise.all(qs.map((qq, w) => (async () => {
    while ((await qq.depth()) > 0 && Date.now() - t0 < 90000) {
      const got = await qq.take(10, 300); takes++
      const now = Date.now()                                                // the whole batch arrived now; its leases began a moment earlier, at the server
      for (const m of got) {
        const i = m.job.i, h = handed.get(i) ?? []
        if (h.length && now - h[h.length - 1].at < LEASE * 0.9 && !h[h.length - 1].done) { doubleLease++; doubles.push({ job: i, afterMs: now - h[h.length - 1].at, atMs: now - t0, workers: [h[h.length - 1].w, w], delivery: m.deliveries }) }   // handed out again inside a live lease
        const rec = { at: now, w, done: false }; h.push(rec); handed.set(i, h)
        if (poison(i)) { rec.done = true; m.nack(); continue }                 // always fails
        if (Math.random() < 0.1) continue                                      // a crashed worker: no ack, the lease lapses
        await sleep(Math.random() * 5)
        if (await m.ack()) { acked.set(i, (acked.get(i) ?? 0) + 1); rec.done = true }
      }
      if (w === 0 && !killed && handed.size > 100) { killedAt = Date.now() - t0; killed = await killLeader(cs[0], 'Q_thumbs' + RUN) }
    }
  })()))
  await sleep(3000)
  const good = [...Array(300).keys()].filter((i) => !poison(i))
  const dead = await q.deadCount(), poisonN = 300 - good.length
  const redelivered = [...handed.values()].filter((h) => h.length > 1).length
  out({ check: 'P-09 every good job acked, none lost, across worker crashes and a leader kill (' + killed + ')', ok: good.every((i) => (acked.get(i) ?? 0) >= 1), good: good.length, ackedOnce: good.filter((i) => acked.get(i) === 1).length, ackedTwice: good.filter((i) => acked.get(i) > 1).length, handedOutMoreThanOnce: redelivered, seconds: +((Date.now() - t0) / 1000).toFixed(1) })
  out({ check: 'P-09 never two live leases on one message', ok: doubleLease === 0, doubleLease, leaseMs: LEASE, leaderKilledAtMs: killedAt, handedOutAgainInsideTheLease: doubles })
  const goodThree = good.filter((i) => handed.get(i).length >= 3)
  out({ check: 'P-09 after 3 deliveries a job goes to the dead-letter queue, and only then', ok: dead === poisonN && (await q.depth()) === 0, poison: poisonN, inDeadQueue: dead, leftInQueue: await q.depth(), poisonHandouts: [...handed.entries()].filter(([i]) => poison(i)).map(([, h]) => h.length).join(','), goodJobsHandedOut3Times: goodThree.map((i) => ({ job: i, acked: acked.get(i) ?? 0, handouts: handed.get(i).length })) })
  // an empty take writes nothing
  const s0 = await q.state(); const c0 = await cs[0].jsm.consumers.info('Q_thumbs' + RUN, 'w'); await q.take(5, 300); const s1 = await q.state(); const c1 = await cs[0].jsm.consumers.info('Q_thumbs' + RUN, 'w')
  out({ check: 'P-09 an empty take writes nothing to the stream', ok: s0.last_seq === s1.last_seq && c0.delivered.stream_seq === c1.delivered.stream_seq, lastSeq: [s0.last_seq, s1.last_seq] })
  q.stop()
  // the dead-letter move when nobody is listening at that moment: the notice is not stored
  const q2 = await queue(cs[1], 'lost' + RUN, { leaseMs: 300, deliveries: 2 })
  await q2.add({ bad: true }); for (let t = 0; t < 3; t++) { for (const m of await q2.take(1, 400)) m.nack(); await sleep(350) }
  q2.reap(); await sleep(1500)
  const stuck = await q2.depth(), deadBefore = await q2.deadCount(); const again = (await q2.take(1, 400)).length; const moved = await q2.sweep()
  out({ check: 'gap: P-09 a job that used up its deliveries always reaches the dead-letter queue', ok: stuck === 0, why: 'JetStream announces "max deliveries" once on a plain subject; if no mover hears it, the job stays in the stream and is never handed out again', stuckInQueue: stuck, inDeadQueue: deadBefore, handedOutAgain: again, movedByAScan: moved, afterScan: { queue: await q2.depth(), dead: await q2.deadCount() } })
  // FIFO per partition, one in flight per partition (SQS FIFO's rule), with 4 workers
  for (const strict of [false, true]) {
    const name = (strict ? 'fifo' : 'loose') + RUN, P = 5, N = 12
    const ws = []; for (let w = 0; w < 4; w++) ws.push(await queue(cs[w], name, { leaseMs: 5000, deliveries: 3, strict }))
    for (let i = 0; i < N; i++) for (let p = 0; p < P; p++) await ws[0].add({ p, i }, { partition: 'p' + p })
    if (strict) for (const w of ws) for (let p = 0; p < P; p++) await w.add({ p, i: -1 }, { partition: 'p' + p, id: name + 'warm' + p }).catch(() => {})   // every worker learns the partitions (the dup id keeps the queue as it was)
    const inFlight = new Array(P).fill(0), lastDone = new Array(P).fill(-1); let overlaps = 0, outOfOrder = 0, done = 0; const t1 = Date.now()
    await Promise.all(ws.map((w) => (async () => { while (done < P * N && Date.now() - t1 < 40000) { for (const m of await w.take(4, 300)) { if (m.job.i < 0) { await m.ack(); continue } const p = m.job.p; if (inFlight[p]++ > 0) overlaps++; await sleep(2 + Math.random() * 10); if (m.job.i < lastDone[p]) outOfOrder++; lastDone[p] = Math.max(lastDone[p], m.job.i); inFlight[p]--; await m.ack(); done++ } } })()))
    out({ check: (strict ? '' : 'gap: ') + 'P-09 FIFO per partition with 4 workers, ' + (strict ? 'one consumer per partition' : 'one shared consumer'), ok: overlaps === 0 && outOfOrder === 0 && done === P * N, done, twoInFlightInOnePartition: overlaps, finishedOutOfOrder: outOfOrder, seconds: +((Date.now() - t1) / 1000).toFixed(1), ...(strict ? { cost: 'a take is one pull per partition; a consumer per partition on the server' } : { why: 'a shared consumer hands the next message of a partition to another worker while the first is still held' }) })
  }
  for (const c of cs) await c.nc.close()
  process.exit(0)
}

if (WHAT === 'failover') {
  // F-05 on BUY, rough: one writer, one write after another; kill -9 the stream's leader; how long until the next
  // acknowledged write? The killed server stays down for 12 s, so the two left must elect. Three rounds.
  const [c] = await clients(1), name = 'fo' + RUN
  const r = await fero(c, name)
  const gaps = []
  for (let round = 0; round < 3; round++) {
    // two clocks: the longest wait for an acknowledgement (the stream has a leader again), and the longest wait
    // for this client's own fold to move (its consumer is back too: only then does it read its own writes)
    let lastAck = performance.now(), worstAck = 0, lastFold = performance.now(), worstFold = 0, seenApplied = r.applied, stop = false, n = 0
    const writer = (async () => { while (!stop) { await r.set('k' + (n++ % 10), { n }, { nowait: true }); const t = performance.now(); worstAck = Math.max(worstAck, t - lastAck); lastAck = t } })()
    const watch = setInterval(() => { const t = performance.now(); if (r.applied !== seenApplied) { seenApplied = r.applied; worstFold = Math.max(worstFold, t - lastFold); lastFold = t } }, 5)
    await sleep(1500); worstAck = 0; worstFold = 0
    const l = await leaderOf(c, 'FERO_' + name); const id = l.slice(1)
    execFileSync(HERE + 'cluster.sh', ['kill', id])
    await sleep(12000)
    execFileSync(HERE + 'cluster.sh', ['start', id], { stdio: 'ignore' })
    await sleep(6000); stop = true; await writer; clearInterval(watch)
    gaps.push({ killed: l, longestGapMs: Math.round(worstAck), longestFoldGapMs: Math.round(worstFold), writes: n })
  }
  out({ check: 'F-05 (rough) writable again after the stream leader is killed', ok: gaps.every((g) => g.longestGapMs <= 2500), bar: '2.5 s (TS) / 1.25 s (native)', note: 'longestGapMs: between two acknowledged writes; longestFoldGapMs: between two folded records on this client (its consumer must come back too)', rounds: gaps, loadavg: (await import('node:fs')).readFileSync('/proc/loadavg', 'utf8').trim() })
  await c.nc.close(); process.exit(0)
}

if (WHAT === 'burn') {
  // 8 clients add 1 to one counter 25 times each. No fault is injected. Run with E44_ONE_ID=1 to see the
  // prototype's first form lose increments (gap 3), and without it to see it count right.
  const cs = await clients(8), name = 'burn' + RUN
  const rs = []; for (const c of cs) rs.push(await fero(c, name))
  await rs[0].set('ctr', { n: 0 })
  let oks = 0, retries = 0, dups = 0
  await Promise.all(rs.map((r) => (async () => { for (let i = 0; i < 25; i++) { const a = await r.incr('ctr', 'n', 1); if (a.ok) oks++; retries += a.retries; if (a.duplicate) dups++ } })()))
  const n = (await rs[0].get('ctr')).value.n
  out({ check: 'every increment answered ok is in the counter (8 clients, no fault)' + (process.env.E44_ONE_ID === '1' ? ', ONE message id per attempt' : ', a message id per try'), ok: n === oks, answeredOk: oks, counter: n, lost: oks - n, retries, answersMarkedDuplicate: dups })
  for (const c of cs) await c.nc.close()
  process.exit(0)
}

if (WHAT === 'dedup') {
  const [c] = await clients(1)
  const r = await fero(c, 'dedup' + RUN, { dedupMs: 1000 })
  const a = await r.set('k', { n: 1 }, { attempt: 'x1' }), b = await r.set('k', { n: 1 }, { attempt: 'x1' })
  await sleep(1600)
  const d = await r.set('k', { n: 1 }, { attempt: 'x1' })
  out({ check: 'a retried attempt lands once inside the dedup window', ok: b.duplicate === true && b.version === a.version, first: a.version, retry: b })
  out({ check: 'gap: F-02 a retried attempt lands once whenever it comes', ok: d.duplicate === true, why: 'after the window (2 minutes by default; 1 s here) the same message id is stored again', retryAfterWindow: d })
  // a conditional op retried after its answer was lost: safe while the row is untouched, applied twice once another write came between
  await r.set('ctr', { n: 0 })
  const i1 = await r.incr('ctr', 'n', 1, {}, { attempt: 'y1' }); const again1 = await r.incr('ctr', 'n', 1, {}, { attempt: 'y1' })
  await r.incr('ctr', 'n', 1, {}, { attempt: 'z1' })                         // someone else's write to the row
  await r.incr('ctr', 'n', 1, {}, { attempt: 'y1' })                         // y1 again: its first answer was "lost"
  const n = (await r.get('ctr')).value.n
  out({ check: 'an incr retried at once is counted once', ok: again1.version === i1.version, n: again1.value.n })
  out({ check: 'gap: F-02 an incr retried after another write to the row is counted once', ok: n === 2, why: 'the attempt id lives only in the row\'s last message; one later write hides it, and the retry runs again (the message id cannot help: it must change with each check-and-write try, see msgid_probe.mjs)', counterIs: n, shouldBe: 2 })
  await c.nc.close(); process.exit(0)
}
