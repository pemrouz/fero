console.log('SERVER MODULE RAN: a server would start here')
export const shop = { name: 'shop' as const, methods: { sell: (sku: string) => sku.length } }
