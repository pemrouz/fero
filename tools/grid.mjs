#!/usr/bin/env node
// The map as plain text (BUILD 1.2, first stage). Run: node tools/grid.mjs
// Rows are layers, columns are slices. A cell is the count of rule records that slice turns on in that layer.
// Everything printed is computed from spec/ledger.json, spec/slices.json and spec/budget.json. Absent data shows as absent.
// It ends 1, with "gate: FAILED" as its last line, when the ledger's form is wrong: a broken ledger is never shown as sound.
import { spec, LAYERS, SLICES, exists, readJson, tally, checkLedger, isPartial, isRaft, inPort } from './ledger-lib.mjs'

export function renderGrid(ledger, slices, budget, later) {
  const t = tally(ledger)
  const NAMES = { L5: 'L5 libraries', L4: 'L4 the surface', L3: 'L3 flow', L2: 'L2 fold and ops', L1: 'L1 the log', L0: 'L0 storage and I/O', D: 'data 5 (sibling)' }
  const W0 = 20, W = 7
  const pad = (s, w) => String(s).padEnd(w)
  const lpad = (s, w) => String(s).padStart(w)
  const edge = (c, b) => `${lpad(c.records, 4)}  ${lpad(c.low + ' to ' + c.high, 11)}  ${lpad(b ?? 'not set', 7)}`
  const row = (label, cells, right) => (pad(label, W0) + cells.map(c => lpad(c, W)).join('') + '  |' + right).trimEnd()
  const cellsOf = l => SLICES.map(s => t.cells[l + ':' + s].records || '.')
  const head = row('fero v5', SLICES.map(s => 'S' + s), ' rules  low to high   budget')
  const width = head.length
  const line = ch => ch.repeat(width)
  const mid = text => { const s = `${'='.repeat(10)} ${text} `; return s + '='.repeat(Math.max(0, width - s.length)) }

  const out = []
  out.push(head)
  if (Array.isArray(slices)) out.push(row('', slices.map(s => String(s.name).split(' ')[0].slice(0, W - 1)), ''))
  out.push(line('-'))
  for (const l of ['L5', 'L4', 'L3', 'L2']) out.push(row(NAMES[l], cellsOf(l), edge(t.layers[l], budget?.layers?.[l])))
  out.push(mid('the line: JavaScript above, Rust below'))
  for (const l of ['L1', 'L0']) out.push(row(NAMES[l], cellsOf(l), edge(t.layers[l], budget?.layers?.[l])))
  out.push(line('-'))
  out.push(row(NAMES.D, cellsOf('D'), edge(t.layers.D, budget?.layers?.D)))
  out.push(line('-'))
  out.push(row('all, records', SLICES.map(s => t.slices[s].records || '.'), edge(t.total, budget?.total)))
  out.push(row('all, low', SLICES.map(s => t.slices[s].low || '.'), ''))
  out.push(row('all, high', SLICES.map(s => t.slices[s].high || '.'), ''))
  out.push(row('budget', SLICES.map(s => budget?.slices ? budget.slices[s] : '-'), budget ? ` ${budget.status}` : ' not set'))
  out.push(line('-'))

  const fero = ledger.filter(r => r.layer !== 'D')
  const n = k => ledger.filter(r => r.known === k).length
  const sum = rs => rs.reduce((a, r) => [a[0] + r.low, a[1] + r.high], [0, 0])
  const fs = sum(fero)
  const raft = ledger.filter(isRaft)
  out.push(`a cell: rule records the slice turns on in the layer.  budget: on the record count${budget ? `, with ${budget.headroom_pct} % of headroom on any line` : ''}.`)
  out.push(`fero alone (L0 to L5): ${fero.length} records, ${fs[0]} to ${fs[1]}.   data 5: ${t.layers.D.records} records, ${t.layers.D.low} to ${t.layers.D.high}.`)
  out.push(`known by: model ${n('model')} (${ledger.filter(isPartial).length} of them on a smaller or older model), seeds ${n('seeds')}, spec ${n('spec')}, code ${n('code')}, measured ${n('measured')}, reasoned only ${n('reasoned')} of ${ledger.length}.`)
  out.push(`unsure grain: ${ledger.filter(r => r.low === 0).length} records may fold into a named other record (low 0); ${ledger.filter(r => r.high > 1).length} may hide more than one rule (high over 1).`)
  out.push(`S0 builds no rule: it proves the Raft port, which carries ${raft.filter(inPort).length} of the ${raft.length} Raft records; S1 turns those on.`)
  out.push(`proven: ${ledger.filter(r => !String(r.proof).startsWith('none-yet')).length} of ${ledger.length}.   kept for after the first build: ${later.length} records (spec/later.json).`)
  out.push(`bars: none judged yet; nothing is built.`)
  return out.join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = checkLedger()
  const slices = exists(spec('slices.json')) ? readJson(spec('slices.json')) : null
  const budget = exists(spec('budget.json')) ? readJson(spec('budget.json')) : null
  console.log(renderGrid(c.ledger, slices, budget, c.later))
  if (c.errors.length) { console.log(`gate: FAILED. The ledger has ${c.errors.length} problem${c.errors.length === 1 ? '' : 's'} of form, so these counts are not to be trusted. Run node tools/ledger-gate.mjs`); process.exit(1) }
}
