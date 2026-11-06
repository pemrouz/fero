// Type-check every example against API.md's own declarations (its `fero.d.ts` and `env.d.ts`
// blocks), with the import pointed at 'fero': the examples use the API exactly as API.md types it.
// Usage: node checks/api-types.mjs   (DATA names data's folder; tsc on PATH)
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const md = readFileSync(join(here, '../../../API.md'), 'utf8')
const data = process.env.DATA ?? '/home/user/pemrouz/data'
const out = mkdtempSync(join(tmpdir(), 'e22-api-'))
for (const [, body, name] of md.matchAll(/```ts\n(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)```/g))
  if (name === 'fero.d.ts' || name === 'env.d.ts') writeFileSync(join(out, name), body)
const examples = readdirSync(join(here, '../examples')).filter((f) => f.endsWith('.ts'))
for (const f of examples) writeFileSync(join(out, f), readFileSync(join(here, '../examples', f), 'utf8').replaceAll("from '../proto/index.ts'", "from 'fero'"))
const compilerOptions = { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true, types: [], lib: ['es2022'], paths: { fero: ['./fero.d.ts'], data: [join(data, 'types/public.d.ts')] } }
writeFileSync(join(out, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: ['fero.d.ts', 'env.d.ts', ...examples] }))
execFileSync('tsc', ['-p', join(out, 'tsconfig.json')], { stdio: 'inherit' })
console.log(`ok: ${examples.length} examples type-check against API.md's fero.d.ts (${examples.join(', ')})`)
