// ids — the ONE place an L5 library here reaches past L4's public surface (API-NOTES D3).
//
// API.md promises that `group.run`'s and `derive`'s outputs "carry attempt ids made from the
// source position, so a re-run after a crash writes nothing twice", and P-15's saga and P-20's
// migrate need the same for their steps. But attempt ids are internal (API.md §8), and no verb
// lets a caller choose one: only a keyed method call's ctx does, and a library cannot make the
// consumer process host a method without making it a server. So the libraries need a write option
// L4 does not have. The proposed public form is `WriteOpts.id`: an idempotency key; a resend, or a
// re-run in another process, with the same id within the dedup horizon is answered from the first
// (a different body under the same id is refused 'call-diverged').
//
// Here it is built outside the core from L4's own internals (a resource handle whose writes take
// their attempt ids from `next()`, the way a keyed call's ctx does), so the core stays step 1's.

import { ResourceImpl, _stackOf, theWorld } from '../../proto/api.ts'

/** writes through the returned handle carry the attempt ids `next()` gives, in call order */
export const withIds = <R = any>(res: { name: string }, next: () => string): R => {
  const w = theWorld()
  const P = w.current()
  const ctx = { who: { peer: P.id, claims: null, session: P.session }, attempt: next, track: () => {}, scope: (l: unknown) => l }
  return new ResourceImpl(_stackOf(w), P, res.name, {}, ctx) as unknown as R
}
