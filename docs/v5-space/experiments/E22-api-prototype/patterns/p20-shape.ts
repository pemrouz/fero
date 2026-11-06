// P-20 change the shape of rows, across three versions. API.md writes one open at version 3; a
// resource that exists is changed online with fero.alter (an open with a new shape is refused
// 'config-differs', D11), so each version is one step here. `UserV3` is the app's schema; passed in.
import { fero } from '../proto/index.ts'
import { migrate } from './lib/index.ts'

export const up = {
  1: (r: any) => r,                                    // v1 → v2: the same record
  2: (r: any) => r.key.length === 1                    // v2 → v3: name becomes { first, last }
    ? { ...r, value: { ...(r.value as any), name: { first: (r.value as any).name, last: '' } } }
    : r,
}
export const v1 = () => fero('users', { server: true })              // shape.version 1, the default
export const v2 = () => fero.alter('users', { shape: { version: 2, up: { 1: up[1] } } })
export const v3 = async (UserV3: any, perSec = 500) => {
  await fero.alter('users', { shape: { version: 3, up } })
  const users = await fero('users', { schema: UserV3 })             // checked at the writer: 'schema' with the path
  const job = await migrate(users, { to: 3, fn: (row: any) => row, perSec })   // rewrite live rows, paced
  await job.done
  return job
}
