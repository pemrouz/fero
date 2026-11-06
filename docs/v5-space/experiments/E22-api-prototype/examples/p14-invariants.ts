// P-14 invariants, as API.md §7 writes it: the methods are the door; `sell` is an op judged at the
// writer, `reprice` a check-then-set carried by a condition.
import { fero, op } from '../proto/index.ts'
type Item = { left: number; price: number }

export const methods = {
  sell: async (sku: string, ctx: any) => {
    const a = await ctx.set([sku, 'left'], op.incr(-1, { min: 0 }))   // two sells of the last one: one ok
    return a.value
  },
  reprice: async ({ sku, price }: { sku: string; price: number }, ctx: any) => {
    const got = await ctx.get(sku, { version: true })                   // check, then set only if unchanged
    if (!got || got.value.price === price) return
    await ctx.set(sku, { ...got.value, price }, { if: { version: got.version } })
  },
}
export const stockServer = (seed: Record<string, Item>, extra: Record<string, any> = {}) =>
  fero<Item>('stock', { methods: { ...methods, ...extra }, data: seed })
