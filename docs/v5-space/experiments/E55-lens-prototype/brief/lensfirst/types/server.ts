// file: server.ts — API.md's own shape: the server exports its handle
import { fero, op } from 'fero'
export const shop = await fero('shop', {
  data: { widgets: { stock: 10, price: 10 } },
  methods: { sell: async (sku: string, ctx) => (await ctx.set([sku, 'stock'], op.incr(-1, { min: 0 }))).value as number },
})
export type Shop = typeof shop
