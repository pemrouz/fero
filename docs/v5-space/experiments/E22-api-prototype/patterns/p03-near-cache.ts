// P-03 near cache, client data sync, as API.md §7 writes it (the server that defines `users` is the
// check's: a bare name with only `cache` is a client).
import { fero } from '../proto/index.ts'

export const p03 = async (print: (...x: unknown[]) => void = console.log) => {
  const users = await fero('users', { cache: { memory: '200MB' } })   // follows only what it reads
  const u = await users.get('u42')               // one hop; from now on u42 is followed
  const same = users.snapshot.u42                // sync; u7 (never read) would throw 'shortfall'
  const mine = users.follow(['u42', 'u43'])      // a snapshot of exactly these, then deltas
  await mine.ready
  mine.tap(() => print(mine.snapshot()))
  print(u, same, mine.cursor())                  // a reconnect resumes from the cursor by itself
  return { users, u, same, mine }
}
