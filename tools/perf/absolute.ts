//! ── tools/perf/absolute — the absolute-tier runner + the ONLY way a baseline gets pinned ────────
//   npm run perf:absolute                 # run all probes, print the delta table, write results/latest.json
//   npm run perf:pin -- --runner=<label> --reason "why"            # pin ADVISORY (the only kind this box allows)
//   npm run perf:pin -- --runner=<label> --reason "..." --pinned   # pinned posture — REFUSED on WSL/VM boxes
//
// A baseline is NEVER written by a normal run (the one deliberate deviation from the scenario
// dashboard's --rebase-in-place idiom): self-seeding wall-ms from an arbitrary box is exactly the
// dishonesty this machinery exists to prevent. See BASELINE.md for the reading + re-pin procedure
// and the FORBIDDEN list.

import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import { syncProbes, counts, strawmanRatio } from './probes.ts'
import { tcpReplicate } from './probes.tcp.ts'
import { compare, fingerprint, pinRefusal, type Baseline, type Current } from './compare.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'results', 'baseline.json')
const LATEST = join(HERE, 'results', 'latest.json')

export const runAll = async (): Promise<Current> => {
  const cur: Current = { counts: counts(), probes: {} }
  for (const p of syncProbes) {
    try { cur.probes[p.id] = await p.run() }
    catch (e) { cur.probes[p.id] = { error: e instanceof Error ? e.message : String(e) } }
  }
  try { cur.probes['node.step-vs-strawman'] = { ratio: strawmanRatio() } }
  catch (e) { cur.probes['node.step-vs-strawman'] = { error: e instanceof Error ? e.message : String(e) } }
  const tcp = await tcpReplicate()
  cur.probes['tcp.replicate-20k'] = tcp.error ? { error: tcp.error } : tcp
  return cur
}

const git = (cmd: string): string => { try { return execSync(cmd, { cwd: HERE, encoding: 'utf8' }).trim() } catch { return '' } }

const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] ?? '').href } catch { return false } })()
if (isMain) {
  const args = process.argv.slice(2)
  const opt = (name: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(`--${name}=`))
    if (eq) return eq.slice(name.length + 3)
    const i = args.indexOf(`--${name}`)
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined
  }
  const f = fingerprint()
  const cur = await runAll()
  mkdirSync(join(HERE, 'results'), { recursive: true })
  writeFileSync(LATEST, JSON.stringify({ when: new Date().toISOString(), fingerprint: f, ...cur }, null, 2))

  if (args.includes('--pin')) {
    const tol = Number(opt('tolerance') ?? 50)
    const refusal = pinRefusal({
      runner: opt('runner'), reason: opt('reason'), pinned: args.includes('--pinned'),
      release: os.release(), tier3Error: (cur.probes['tcp.replicate-20k'] as { error?: string }).error, msTolerancePct: tol,
    })
    if (refusal) { console.error(`pin refused: ${refusal}`); process.exit(2) }
    //! a pin must carry EVERY graduated row — silently dropping an erroring probe would ship a
    // baseline that under-claims its own coverage (the review-round gap, closed)
    const broken = Object.entries(cur.probes).filter(([, p]) => p.error)
    if (broken.length) { console.error(`pin refused: probes errored — ${broken.map(([id, p]) => `${id} (${p.error})`).join('; ')}`); process.exit(2) }
    //! the concurrent-sessions guard: refuse when the working-tree baseline differs from HEAD's copy
    if (!args.includes('--force') && existsSync(BASELINE)) {
      const prefix = git('git rev-parse --show-prefix')
      const headCopy = git(`git show HEAD:${prefix}results/baseline.json`)
      if (headCopy && headCopy !== readFileSync(BASELINE, 'utf8').trim())
        { console.error('pin refused: results/baseline.json differs from HEAD — another session moved it; reconcile or --force'); process.exit(2) }
    }
    const old = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline) : null
    const baseline: Baseline = {
      schema: 1, kind: 'fero-v3-absolute-baseline',
      rev: git('git rev-parse --short HEAD') || 'unknown',
      when: new Date().toISOString(),
      dirty: git('git status --porcelain') !== '',
      reason: opt('reason')!,
      supersedes: old ? { rev: old.rev, when: old.when } : null,
      runner: {
        id: opt('runner')!,
        posture: args.includes('--pinned') ? 'pinned' : 'advisory',
        host: f.host, os: f.os, release: os.release(), cpu: f.cpu, node: process.versions.node,
      },
      msTolerancePct: tol,
      counts: cur.counts,
      probes: Object.fromEntries(
        Object.entries(cur.probes)
          .filter(([, p]) => !p.error)
          .map(([id, p]) => [id, { file: syncProbes.find((x) => x.id === id)?.file ?? (id.startsWith('tcp.') ? 'tools/perf/probes.tcp.ts' : 'kernel/node.perf.ts'), ...p }]),
      ) as Baseline['probes'],
    }
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n')
    console.log(`pinned ${baseline.runner.posture} baseline for runner '${baseline.runner.id}' at ${baseline.rev}${baseline.dirty ? ' (DIRTY tree)' : ''}`)
    process.exit(0)
  }

  //! plain run: print the table + verdicts; exit nonzero on count-drift / probe-error / ENFORCED ms-delta
  for (const [id, p] of Object.entries(cur.probes))
    console.log(p.error
      ? `  ${id.padEnd(26)} PROBE-ERROR: ${p.error}`
      : p.ratio !== undefined
        ? `  ${id.padEnd(26)} ratio ${p.ratio}`
        : `  ${id.padEnd(26)} ${String(p.ms).padStart(8)}ms  ${String(p.persec?.toLocaleString()).padStart(12)}/s`)
  if (!existsSync(BASELINE)) { console.log('no tracked baseline — pin one with npm run perf:pin (see BASELINE.md)'); process.exit(0) }
  const verdicts = compare(JSON.parse(readFileSync(BASELINE, 'utf8')), cur, f)
  let bad = false
  for (const v of verdicts) {
    if (v.kind === 'count-drift') { bad = true; console.error(`  COUNT DRIFT ${v.key}: ${v.want} → ${v.got} (a wire law moved — DECISIONS + re-pin, or a regression)`) }
    else if (v.kind === 'probe-error') { bad = true; console.error(`  PROBE ERROR ${v.id}: ${v.error}`) }
    else if (v.kind === 'ms-delta') { if (v.enforce) bad = true; console.log(`  ${v.enforce ? 'REGRESSION' : 'slower'} ${v.id}: ${v.baseMs}ms → ${v.curMs}ms (+${v.pct}%)`) }
    else if (v.kind === 'improved') console.log(`  improved ${v.id}: ${v.baseMs}ms → ${v.curMs}ms (${v.pct}%) — re-pin candidate`)
    else if (v.kind === 'no-runner-match') console.log(`  ms tier skipped — baseline pinned on ${v.pinnedOn}; this box is not it`)
    else if (v.kind === 'stale') console.log(`  stale baseline row: ${v.id}`)
    else if (v.kind === 'unpinned') console.log(`  unpinned probe: ${v.id} (add a row by re-pinning)`)
    else console.error(`  UNKNOWN SCHEMA ${JSON.stringify(v)} — both tiers skipped loudly`)
  }
  process.exit(bad ? 1 : 0)
}
