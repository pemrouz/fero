import { shop } from './server.ts'
type Shop = typeof shop
const x: Shop['name'] = 'shop'
console.log('client (plain import, used only as a type) ran', x)
