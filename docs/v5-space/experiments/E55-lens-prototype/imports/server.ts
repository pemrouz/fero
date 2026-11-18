// file: server.ts — a server file: if this module runs, a server would start here
console.log('SERVER MODULE RAN')
export const shop = { name: 'shop' as const, methods: { sell: (n: number) => n } }
export type Shop = typeof shop
