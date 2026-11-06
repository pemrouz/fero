// P-08 consumer groups, as API.md §7 writes it. `bill` is the app's (API.md's env.d.ts); here it is
// passed in. The two groups are split so a check can run several members of each.
import { fero } from '../proto/index.ts'
import { group } from './lib/index.ts'

// effectively once: the output and the cursor commit together
export const invoicing = async () => {
  const orders = await fero('orders')
  const invoices = await fero('invoices')
  const g = await group(orders, 'invoicing')
  return g.run((e, out) => out.use(invoices).set(e.partition, { order: e.row, at: e.t }))
}

// at least once: commit when the batch is done
export const billing = async (bill: (order: unknown) => Promise<void>, until: () => boolean) => {
  const orders = await fero('orders')
  const g = await group(orders, 'billing')          // members share the stream; one owner per share
  for await (const batch of g) {
    for (const e of batch.entries) await bill(e.row)
    await batch.commit()                             // a paused (zombie) member is refused 'fenced'
    if (until()) break
  }
  return g
}
