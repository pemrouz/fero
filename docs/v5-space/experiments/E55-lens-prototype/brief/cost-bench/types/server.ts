import { fero, op } from 'fero'
export const shop = await fero('shop', {
  data: { widgets: { stock: 10, price: 10 } },
  methods: {
    sell: async (sku: string, ctx) => { const a = await ctx.set([sku, 'stock'], op.incr(-1, { min: 0 })); return { sku, left: a.value as number } },
    low: (max: number, ctx) => ctx.data.lt('stock', max),
  },
})
export type Shop = typeof shop
