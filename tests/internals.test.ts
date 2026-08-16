//! the './internals' escape hatch must LOAD — it re-exports the REAL layers (plan §3.3),
// and a stale re-export of a deleted symbol is a SyntaxError at import time for the whole
// entry. The v4 D2 rewrite deleted the capture sink but internals.ts kept re-exporting it,
// so `import 'fero/internals'` threw until the v4 re-evaluation caught it (no test imported
// the entry). This pins the entry against the next deletion.

import { test } from 'node:test'
import assert from 'node:assert'

test("the './internals' entry loads and exposes the real layers", async () => {
  const m = await import('../internals.ts')
  for (const k of [
    // kernel + shells
    'Node', 'Membership', 'Writes', 'Ring', 'Streams', 'Confirm', 'Link', 'Journal',
    'Framer', 'REC', 'Runtime', 'Sim',
    // api layer
    'fero', 'Bind', 'Host', 'diagnostics',
    // substrate (the D2-rewritten surface — no capture sink anymore)
    'proxy', 'snapshot', 'applyRec', 'applyStreamRec', 'records', 'isProxy', 'lens', 'unwrap', 'contract', 'ORIGIN',
  ])
    assert.ok(k in m, `internals exports ${k}`)
  assert.ok(!('capture' in m), 'the v2-era capture sink stays deleted, not re-exported')
})
