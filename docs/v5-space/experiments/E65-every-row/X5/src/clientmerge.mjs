// E-65 X5, part `clientmerge`: clients that merge the groups' partials themselves, against one merger
// and against a merger with relays (MERGE.md 3.7's last item, which its skeptic said does not win).
//
// A counting run, plus a check. G groups own slots; N rows; W writes. Two views:
//   top10   the 10 highest scores (random scores, or rising scores: each write a new best)
//   sums    the sum of cents per country (100 buckets)
// Each group keeps its partial (its own top 10; its own sum per bucket). A partial FRAME is sent when the
// group's partial changes. The merger, or each client, keeps every group's partial and answers the merge:
// the best 10 of the union; per bucket the sum of the groups' sums. A MERGED frame is sent when the answer
// changes.
// Counted per write: partial frames, merged frames, entries in each. From them, for C clients:
//   M   one merger: it receives the partial frames once and sends each merged frame to C clients
//   MR  a merger and C/1000 relays: the merger sends to the relays, each relay to its 1,000 clients
//   CM  client merge: each group's partial host sends its frames to all C clients; a client receives every
//       group's frames over G links
// The check: the client's merged answer equals the oracle's (the query over every row) after every write.
// Planted bug CMBUG=answeronly: the client keeps only the merged answer, not every group's partial, and
// merges each partial frame into it (a row that leaves the top 10 cannot be replaced).
// Usage: node clientmerge.mjs [seeds]   env G (16), N (1e5), W (2e5), CMBUG; prints JSON lines
const G = +(process.env.G ?? 16), N = +(process.env.N ?? 1e5), W = +(process.env.W ?? 2e5)
const BUG = process.env.CMBUG ?? ''
const K = 10, B = 100

function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
// a group's top 10, as a sorted array of [score, key]; rebuilt from the group's rows only when a member
// leaves or drops (the partial host's own work, not counted here)
const better = (a, b) => (a[0] !== b[0] ? b[0] - a[0] : (a[1] < b[1] ? -1 : 1))
function topOf(rows, keys) {
  const arr = []
  for (const k of keys) { const s = rows[k].score; if (arr.length < K || s > arr[K - 1][0] || (s === arr[K - 1][0] && k < arr[K - 1][1])) { arr.push([s, k]); arr.sort(better); if (arr.length > K) arr.pop() } }
  return arr
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x[0] === b[i][0] && x[1] === b[i][1])
const mergeTop = (parts) => parts.flat().sort(better).slice(0, K)

function run(seed, mode) {
  const r = rng(seed)
  const rows = [], groupKeys = Array.from({ length: G }, () => new Set())
  for (let k = 0; k < N; k++) { rows.push({ score: Math.floor(r() * 1e9), cents: Math.floor(r() * 1e4), bucket: Math.floor(r() * B), g: Math.floor(r() * G) }); groupKeys[rows[k].g].add(k) }
  const part = groupKeys.map((ks) => topOf(rows, ks))         // each group's partial top 10
  const psum = Array.from({ length: G }, () => new Float64Array(B))
  for (const row of rows) psum[row.g][row.bucket] += row.cents
  let merged = mergeTop(part)
  const client = { parts: part.map((p) => p.slice()), answer: merged.slice() }   // one client, merging
  const c = { pTop: 0, pTopEntries: 0, mTop: 0, mTopEntries: 0, pSum: 0, mSum: 0, bad: 0, pTopByGroup: new Array(G).fill(0) }
  let rising = 2e9
  for (let w = 0; w < W; w++) {
    const k = Math.floor(r() * N), row = rows[k], g = row.g
    row.score = mode === 'rising' ? rising++ : Math.floor(r() * 1e9)
    const oldC = row.cents; row.cents = Math.floor(r() * 1e4)
    // sums: the group's partial changes by (new - old): one partial frame, one merged frame (if not equal)
    if (row.cents !== oldC) { psum[g][row.bucket] += row.cents - oldC; c.pSum++; c.mSum++ }
    // top 10: does this group's partial change?
    const before = part[g]
    const inBefore = before.some((x) => x[1] === k)
    let after
    if (inBefore) after = topOf(rows, groupKeys[g])            // a member moved: recompute from the group's rows
    else if (before.length < K || row.score > before[K - 1][0]) after = [...before, [row.score, k]].sort(better).slice(0, K)
    else after = before
    if (!same(before, after)) {
      part[g] = after; c.pTop++; c.pTopByGroup[g]++
      const changed = after.filter((x) => !before.some((y) => y[1] === x[1] && y[0] === x[0])).length + before.filter((y) => !after.some((x) => x[1] === y[1])).length
      c.pTopEntries += changed
      // the client takes the partial frame
      if (BUG === 'answeronly') {
        // keeps only the answer: removes keys the frame says left this group's top 10, adds the new entries
        const gone = new Set(before.filter((y) => !after.some((x) => x[1] === y[1])).map((y) => y[1]))
        client.answer = mergeTop([client.answer.filter((x) => !gone.has(x[1]) && !after.some((y) => y[1] === x[1])), after])
      } else { client.parts[g] = after.slice(); client.answer = mergeTop(client.parts) }
      const m2 = mergeTop(part)
      if (!same(m2, merged)) { c.mTop++; c.mTopEntries += m2.filter((x) => !merged.some((y) => y[1] === x[1] && y[0] === x[0])).length + merged.filter((y) => !m2.some((x) => x[1] === y[1])).length; merged = m2 }
    }
    // the oracle: the query over every row, checked every 1,000 writes and at the end
    if (w % 1000 === 999 || w === W - 1) { const truth = topOf(rows, rows.keys()); if (!same(truth, client.answer)) c.bad++ }
  }
  const perW = (x) => +(x / W).toFixed(5)
  const maxGroupShare = Math.max(...c.pTopByGroup) / Math.max(1, c.pTop)
  return { seed, mode, G, N, W, bug: BUG || 'none', fail: c.bad > 0, badChecks: c.bad,
    top10: { partialFramesPerWrite: perW(c.pTop), partialEntriesPerFrame: +(c.pTopEntries / Math.max(1, c.pTop)).toFixed(2), mergedFramesPerWrite: perW(c.mTop), mergedEntriesPerFrame: +(c.mTopEntries / Math.max(1, c.mTop)).toFixed(2), busiestGroupShare: +maxGroupShare.toFixed(3) },
    sums: { partialFramesPerWrite: perW(c.pSum), mergedFramesPerWrite: perW(c.mSum) } }
}

// sends per write for C clients, by placement, from the counted frame rates
function placements(view, C) {
  const p = view.partialFramesPerWrite, m = view.mergedFramesPerWrite, share = view.busiestGroupShare ?? 1 / G
  const R = Math.max(1, Math.ceil(C / 1000))
  return {
    C,
    M: { busiestSendsPerWrite: +(C * m).toFixed(3), totalSendsPerWrite: +(C * m + p).toFixed(3), clientRecvPerWrite: m, linksPerClient: 1 },
    MR: { relays: R, busiestSendsPerWrite: +Math.max(R * m, (C / R) * m).toFixed(3), totalSendsPerWrite: +(C * m + R * m + p).toFixed(3), clientRecvPerWrite: m, linksPerClient: 1 },
    CM: { busiestSendsPerWrite: +(C * p * share).toFixed(3), totalSendsPerWrite: +(C * p).toFixed(3), clientRecvPerWrite: p, linksPerClient: G },
  }
}

const seeds = +(process.argv[2] ?? 3)
for (const mode of ['random', 'rising']) {
  let fails = 0
  for (let s = 1; s <= seeds; s++) {
    const res = run(s, mode)
    if (res.fail) fails++
    if (s === 1) {
      res.placements = { top10: [100, 1000, 10000].map((C) => placements(res.top10, C)), sums: [100, 1000, 10000].map((C) => placements({ ...res.sums, busiestGroupShare: 1 / G }, C)) }
    }
    console.log(JSON.stringify(res))
  }
  console.log(JSON.stringify({ part: 'clientmerge', mode, bug: BUG || 'none', seeds, failed: fails }))
}
