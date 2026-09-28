//! Tier-3 examples smoke: every examples/NN-*/check.ts runs bounded under a PRIVATE rendezvous port
// and must end with `ok <dir>`. The examples are the public surface's worked lessons; this suite is
// what keeps them from rotting. Each check is a real multi-process run over real sockets: budgets are
// generous (WSL2 swings 2-3×), a forgotten destroy() shows up as a timeout, and the whole process
// GROUP is killed in `finally` so a failed assertion never leaks a role server.

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ports } from '#utils'

const ROOT = path.join(import.meta.dirname, '..', 'examples')
const dirs = readdirSync(ROOT).filter((d) => /^\d\d-/.test(d)).sort()
const index = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
//! per-example wall budgets (ms) — the default suits a two-process story; slow tiers add their own rows
const BUDGET: Record<string, number> = { '03-one-write': 60_000, '08-methods': 52_000, '09-live': 80_000, '10-confirm': 42_000, '13-cluster-of-three': 53_000, '17-lww-honesty': 50_000, '30-fleet-audit': 100_000 }
const budget = (dir: string) => BUDGET[dir] ?? 40_000
//! the debugger series (2x) is the ONE place an example may import internals; nobody imports #utils
const mayImportInternals = (dir: string) => dir.startsWith('2')

for (const dir of dirs) {
  test(`examples/${dir}: check.ts ends with ok`, async () => {
    const folder = path.join(ROOT, dir)
    assert.ok(existsSync(path.join(folder, 'check.ts')), `${dir}/check.ts exists`)
    assert.ok(existsSync(path.join(folder, 'README.md')), `${dir}/README.md exists`)
    assert.ok(index.includes(`[${dir.slice(3)}](${dir}/)`), `${dir} is listed in examples/README.md`)
    for (const f of readdirSync(folder).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(path.join(folder, f), 'utf8')
      assert.ok(!src.includes("'#utils'"), `${dir}/${f} must not import #utils (examples are the public surface)`)
      if (!mayImportInternals(dir)) assert.ok(!src.includes('internals.ts'), `${dir}/${f} must not import internals`)
    }
    const rendezvous = `127.0.0.1:${await ports.free()}`
    const child = spawn(process.execPath, [path.join(folder, 'check.ts')], {
      cwd: folder,
      env: { ...process.env, FERO_RENDEZVOUS: rendezvous },
      detached: true, // its own process group: the group kill below reaches every role it spawned
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d })
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d })
    const killGroup = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }
    try {
      const code = await new Promise<number | null | 'timeout'>((resolve) => {
        const t = setTimeout(() => { killGroup(); resolve('timeout') }, budget(dir))
        child.once('exit', (c) => { clearTimeout(t); resolve(c) })
      })
      const tail = (s: string) => s.trim().split('\n').slice(-12).join('\n')
      assert.equal(code, 0, `${dir}/check.ts exited ${code}\n--- stdout tail ---\n${tail(out)}\n--- stderr tail ---\n${tail(err)}`)
      assert.equal(out.trim().split('\n').pop(), `ok ${dir}`, `${dir}/check.ts must end with its ok line\n${tail(out)}`)
    } finally {
      killGroup()
    }
  })
}
