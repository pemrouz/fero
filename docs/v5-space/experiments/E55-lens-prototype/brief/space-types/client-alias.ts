import { fero } from 'fero'
import type { Shop } from './server.ts'
const c = await fero<Shop>('shop')
export const left: number = (await c.methods.sell('widgets')).left
