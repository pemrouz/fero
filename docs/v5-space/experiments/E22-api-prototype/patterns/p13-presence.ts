// P-13 presence, as API.md §7 writes it (the servers of `online` and `here` are the check's: a
// resource key is not a server marker, C1, and a presence writer is a client).
import { fero } from '../proto/index.ts'

export const p13 = async (who: string) => {
  const online = await fero('online', { rows: { while: 'session' } })   // every row dies with its writer's session
  await online.set(who, { since: fero.now() })
  const here = await fero('here', { partition: { before: '/' } })
  await here.set(`room1/${who}`, { since: fero.now() }, { while: 'session' })   // one row bound to the session
  return { online, here }
}
