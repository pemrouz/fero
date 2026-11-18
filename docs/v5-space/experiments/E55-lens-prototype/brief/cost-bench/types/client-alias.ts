import { fero } from 'fero'
import type { Shop } from './server.ts'
const c = await fero<Shop>('shop')
const s = await c.methods.sell('widgets')
// @ts-expect-error no such method
c.methods.refund('x')
export const left2: number = s.left
