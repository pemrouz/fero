// P-17 derived resources, as API.md §7 writes it.
import { fero, op } from '../proto/index.ts'
import { derive } from './lib/index.ts'
type Order = { user: string; cents: number }

export const p17 = async () => {
  const orders = await fero<Order>('orders')
  const totals = await fero<number>('totals')
  return derive(orders, totals, (e, out) => e.row && out.set(e.row.user, op.incr(e.row.cents)))   // once per order
}
