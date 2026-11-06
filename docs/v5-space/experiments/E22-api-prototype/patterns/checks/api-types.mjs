// Type-check every pattern example against API.md's own declarations (its `fero.d.ts` and `env.d.ts`
// blocks), with both imports (the prototype's index and the L5 libraries) pointed at 'fero': the
// examples then use the API exactly as API.md types it. Usage: node checks/api-types.mjs
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const md = readFileSync(join(here, '../../../../API.md'), 'utf8')
const data = process.env.DATA ?? '/home/user/pemrouz/data'
const out = mkdtempSync(join(tmpdir(), 'e22-patterns-'))
for (const [, body, name] of md.matchAll(/```ts\n(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)```/g))
  if (name === 'fero.d.ts' || name === 'env.d.ts') writeFileSync(join(out, name), body)
const files = readdirSync(join(here, '..')).filter((f) => /^p\d\d-.*\.ts$/.test(f)).sort()
for (const f of files) writeFileSync(join(out, f), readFileSync(join(here, '..', f), 'utf8').replaceAll("from '../proto/index.ts'", "from 'fero'").replaceAll("from './lib/index.ts'", "from 'fero'"))
const compilerOptions = { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true, types: [], lib: ['es2022'], paths: { fero: ['./fero.d.ts'], data: [join(data, 'types/public.d.ts')] } }
writeFileSync(join(out, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: ['fero.d.ts', 'env.d.ts', ...files] }))
let failed = false
try { execFileSync('tsc', ['-p', join(out, 'tsconfig.json')], { stdio: 'pipe' }) } catch (e) { failed = true; process.stdout.write(String(e.stdout).replaceAll(out + '/', '')) }
console.log(failed ? `the errors above: where the examples leave API.md's types (each is in API-NOTES D)` : `ok: ${files.length} examples type-check against API.md's fero.d.ts`)
