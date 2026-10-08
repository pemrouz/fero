//! tests/config.child — the end-to-end tier's child: `node config.child.ts <name>[,<name>…] [--fero.* …]`
// composes each named resource through the PUBLIC fero() with the process's REAL argv, env, cwd and
// $HOME, prints one JSON line per resource ({ name, config: diag(f).config(), me }) or `ERR <message>`,
// then destroys them. The call's opts ride CHILD_CALL (JSON) so a test can put a value in the call too.
// CHILD_VALIDATION=top|seams adds a rule (a function cannot ride JSON) under that spelling, and each line
// then carries `refused`: the reason a write of row 'bad' was refused with.
// Not a test file (the battery's glob is tests/*.test.ts).

import { fero } from '../api/index.ts'
import { diag } from '../api/diagnostics.ts'

const names = (process.argv[2] ?? 'r').split(',')
const call = JSON.parse(process.env.CHILD_CALL ?? '{}') as Record<string, unknown>
const rule = (r: { key: string[] }) => r.key[0] !== 'bad' || 'no bad rows'
if (process.env.CHILD_VALIDATION === 'top') call.validation = rule
if (process.env.CHILD_VALIDATION === 'seams') call.seams = { validation: rule }
const made: Awaited<ReturnType<typeof fero>>[] = []
try {
  for (const name of names) {
    const f = await fero(name, call)
    made.push(f)
    const refused = call.validation !== undefined || call.seams !== undefined
      ? await f.methods.update({ key: 'bad', value: 1 }).then(() => null, (e: { reason: string }) => e.reason) : undefined
    console.log(JSON.stringify({ name, config: diag(f)!.config(), me: f.cluster.me.snapshot(), ...(refused !== undefined ? { refused } : {}) }))
  }
} catch (e) {
  console.log(`ERR ${(e as Error).message}`)
  process.exitCode = 1
}
for (const f of made) await f.destroy()
