// P-10 locks and leader election, as API.md §7 writes it. `process.pid` becomes the writer's name,
// and `process.exit` a callback (one OS process holds every simulated one).
import { fero } from '../proto/index.ts'
import { lock } from './lib/index.ts'

export const payroll = async (me: string, work: () => Promise<void> = async () => {}) => {
  const ledger = await fero('ledger')
  const l = await lock('payroll', { lease: '10s', wait: '20s' })            // else 'locked'
  await work()                                                               // (a pause lands here in the check)
  await ledger.set('run-42', { by: me }, { if: { fence: l.fence } })         // an older token: 'fenced'
  await l.release()
  return l
}
export const elect = async (exit: () => void) => {
  const leader = await lock('leader:billing', { wait: 'forever' })          // leader election
  leader.lost.then(() => exit())                                             // lost the lease: stop acting
  return leader
}
