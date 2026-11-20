// A2's cost: a ring resume against a new picture, for best(10) and byTeam, at N rows. The copy keeps the last 64
// frames; a client that missed K = 8 frames resumes from the ring, or (another instance) gets a picture. Measured:
// the bytes of each answer, the copy's time to make it, and the client's time to decode it (JSON.parse). The ways
// interleave round by round, a full collection before each, the median of 5 rounds of 1,000 answers.
//   node --expose-gc --experimental-strip-types resume.mjs <N>
import { newCopy, sub, gcAsync, now, med, r1, r3, out, rng } from './common.mjs'

const N = +process.argv[2], K = 8, M = 1000
const res = {}
for (const [name, spec, f] of [['best', { method: 'best', arg: 10 }, 'points'], ['byTeam', { method: 'byTeam', arg: null }, 'pts']]) {
  const { w, c } = newCopy(N)
  sub(c, spec)
  const r = rng(5)
  const e = [...c.entries.values()][0]
  let p = 0
  while (e.seq < 3 * K) { const k = 'k' + (r() % N); c.fold(++p, [{ k, f, v: f === 'points' ? r() % 10 : ((r() % 2001) - 1000) / 10 }]) } // fill the ring
  const ways = {
    ring: { inst: e.inst, seq: e.seq - K },
    picture: { inst: 'another-instance', seq: e.seq - K },
  }
  const xs = { ring: [], picture: [] }, dec = { ring: [], picture: [] }, bytes = {}
  for (let round = 0; round < 5; round++) for (const [way, resume] of Object.entries(ways)) {
    const texts = []
    await gcAsync()
    const t0 = now()
    for (let i = 0; i < M; i++) {
      c.onMsg(2, 1, { t: 'sub', h: 100000 + i, cls: 'C', method: spec.method, arg: spec.arg, place: 'x', seen: 0, resume })
      texts.push(w.last)
      c.onMsg(2, 1, { t: 'unsub', h: 100000 + i })
    }
    xs[way].push(Number(now() - t0) / M / 1000)
    bytes[way] = texts[0].length
    await gcAsync()
    const t1 = now()
    for (const t of texts) JSON.parse(t)
    dec[way].push(Number(now() - t1) / M / 1000)
  }
  res[name] = { framesMissed: K, bytes, copyUsPerAnswer: { ring: r3(med(xs.ring)), picture: r3(med(xs.picture)) }, clientDecodeUs: { ring: r3(med(dec.ring)), picture: r3(med(dec.picture)) }, ringResumes: w.stats.ringResumes, pictures: w.stats.pictures }
}
out({ claim: 'A2', bench: 'resume', rows: N, ...res })
