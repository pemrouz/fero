// file: client-type.ts — `import type` with API.md's declarations
import { fero } from 'fero'
import type { shop, Shop } from './server.ts'
const a = await fero<typeof shop>('shop')
const b = await fero<Shop>('shop')
const n: number = await a.methods.sell('widgets')
b.methods.refund('widgets')
console.log(n)
