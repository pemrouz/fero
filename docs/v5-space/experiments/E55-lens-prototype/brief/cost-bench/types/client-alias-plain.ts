import { fero } from 'fero'
// @ts-expect-error TS1484 under verbatimModuleSyntax: a type must be imported with `import type`
import { Shop } from './server.ts'
export const c2 = await fero<Shop>('shop')
