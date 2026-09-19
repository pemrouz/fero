//! Perf sibling (V4-10): the config layer runs ONCE per public fero() — construction, never a hot path —
// so this pin is a tripwire against the layer growing a cost that shows up in a process composing many
// resources: three optcascade reads (a minimist parse, an envdeep walk, the memoized file resolver) plus
// the schema walk and the coercions. Measured ≈15 µs per resolve with injected sources; the ceiling is
// wide on purpose (WSL2 swings 2-3x) and is never to be widened. With FERO_CONFIG=off the cost is the
// call's own walk alone.

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from './config.ts'
import { bench } from '#utils'

test('absolute: 1000 resolves (flags + env + a memoized empty file layer) under the tripwire ceiling', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-config-perf-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-config-perf-'))
  const sources = { cwd, home, argv: ['--fero.heartbeat.ms', '250', '--fero.hosts', 'a:1,b:2', '--seeds', '1000'], env: { FERO_REDIAL_MS: '30', FERO_RENDEZVOUS: 'off', FERO_SHOP_DIR: './shop', HOME: home } }
  const call = { server: true, journal: { cap: 64 } }
  const N = 1000
  const ms = bench.time(() => {
    for (let i = 0; i < N; i++) resolveConfig('shop', call, sources)
  })
  const per = ms / N
  console.log(`config: ${N} resolves in ${ms.toFixed(1)} ms (${(per * 1000).toFixed(1)} µs each)`)
  assert.ok(ms < 500, `${N} resolves took ${ms.toFixed(1)} ms (ceiling 500)`)
})

test('absolute: 1000 resolves with FERO_CONFIG=off — the call\'s walk alone', () => {
  const call = { server: true, heartbeat: { ms: 50 }, hosts: ['a:1'] }
  const sources = { argv: ['--fero.dir', './x'], env: { FERO_CONFIG: 'off', FERO_DIR: './y' } }
  const N = 1000
  const ms = bench.time(() => {
    for (let i = 0; i < N; i++) resolveConfig('shop', call, sources)
  })
  console.log(`config (off): ${N} resolves in ${ms.toFixed(1)} ms`)
  assert.ok(ms < 100, `${N} off-resolves took ${ms.toFixed(1)} ms (ceiling 100)`)
})
