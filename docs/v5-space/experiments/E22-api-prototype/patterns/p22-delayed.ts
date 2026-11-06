// P-22 delayed jobs, waiting takes, priorities, as API.md §7 writes it. `sendMail` is the app's;
// passed in. Adding and taking are split so a check can time the wake.
import { queue } from './lib/index.ts'

export const enqueue = async () => {
  const mail = await queue<{ to: string }>('mail')
  await mail.add({ to: 'ada@x.io' }, { delay: '15m' })
  await mail.add({ to: 'ops@x.io' }, { cron: '0 6 * * *', id: 'daily-report' })
  await mail.add({ to: 'vip@x.io' }, { priority: 0 })
}
export const consume = async (sendMail: (to: string) => Promise<void>) => {
  const mail = await queue<{ to: string }>('mail')
  const [m] = await mail.take(1, { wait: '20s' })   // woken by an enqueue; writes nothing while waiting
  if (m) { await sendMail(m.job.to); await m.ack() }
  return m
}
