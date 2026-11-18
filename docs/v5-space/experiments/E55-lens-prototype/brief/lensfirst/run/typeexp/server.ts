console.log('SERVER MODULE RAN: a server would start here')
const shop = { name: 'shop' as const, methods: { sell: (sku: string) => sku.length } }
export type Shop = typeof shop
