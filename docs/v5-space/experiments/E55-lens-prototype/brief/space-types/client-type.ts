import { fero } from 'fero'
import type { shop } from './server.ts'
const c = await fero<typeof shop>('shop')
const s = await c.methods.sell('widgets')
export const left: number = s.left
// @ts-expect-error no such method
c.methods.refund('x')
