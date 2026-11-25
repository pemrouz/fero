// Runs every check of the API prototype in ONE process, one after the other (the `ts-one` mode
// of run.sh copies this file into the marked copy of the prototype). Each check prints its own
// `ok` line or its failures; the process ends with an error when any check failed.
// Flags are the checks' own: --seeds N.
import { readdirSync } from 'node:fs'
import { report } from './proto/check.ts'

for (const dir of ['checks', 'patterns/checks']) {
  for (const f of readdirSync(new URL(`./${dir}/`, import.meta.url)).filter((x) => x.endsWith('.check.ts')).sort()) {
    const url = new URL(`./${dir}/${f}`, import.meta.url).href
    const name = f.replace('.check.ts', '')
    try {
      const m = await import(url)
      // A check with no run() runs only as its own program; it is left out here, and said.
      if (typeof m.run !== 'function') { console.log(`skip ${name}: it exports no run()`); continue }
      const r = await m.run()
      if (Array.isArray(r?.failed)) report(r, url)
      else if (r?.same === r?.seeds && r?.distinct === r?.seeds) console.log(`ok ${name}`)
      else { console.log(`FAIL ${name} gave another run on the same seed`); process.exitCode = 1 }
    } catch (e) {
      console.log(`FAIL ${name} threw: ${String((e as Error)?.message ?? e)}`)
      process.exitCode = 1
    }
  }
}
