// P-09 work queue, as API.md §7 writes it. `resize` is the app's (API.md's env.d.ts); here it is
// passed in. `add` and `work` are split so a check can run a producer and several workers.
import { queue } from './lib/index.ts'

export const producer = async (urls: string[]) => {
  const jobs = await queue<{ url: string }>('thumbs', { lease: '30s', deliveries: 5 })
  for (const url of urls) await jobs.add({ url })
}
export const worker = async (resize: (url: string) => Promise<string>) => {
  const jobs = await queue<{ url: string }>('thumbs', { lease: '30s', deliveries: 5 })
  return jobs.work(async (job) => { await resize(job.url) })   // returns: ack; throws: nack; 5 deliveries: thumbs.dead
}
