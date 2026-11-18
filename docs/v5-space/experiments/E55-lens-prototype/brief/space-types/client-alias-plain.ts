import { fero } from 'fero'
// @ts-expect-error TS1484 under verbatimModuleSyntax: a type must be imported with `import type`
import { Shop } from './server.ts'
const c = await fero<Shop>('shop')
export const left: number = (await c.methods.sell('widgets')).left
