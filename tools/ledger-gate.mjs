#!/usr/bin/env node
// The ledger gate (BUILD 1.1). Run: node tools/ledger-gate.mjs
// It fails when:
//   1. a record in spec/ledger.json or spec/later.json is malformed, holds more than one sentence, or an id repeats or is used again
//      after it was retired (spec/retired.json);
//   2. a record claims more than it has: a proof, a site or a test before anything is built; a "known" by model, seeds or
//      measurement that names no experiment or file; a low of 0 that names no record it may fold into;
//   3. spec/budget.json is missing, names no card, differs from the line its card holds, has more than 10 % of headroom,
//      or a layer, a slice or the whole passes it;
//   4. spec/slices.json is missing or disagrees with the ledger's own counts or its data 5 mechanisms;
//   5. a page names a rule id that does not exist, or SYSTEM.md, README.md or the open budget card states a count the ledger does not have.
// It cannot see a rule whose code carries no marker; that is another tool's job (BUILD 2.6).
import fs from 'node:fs'
import { spec, LAYERS, SLICES, KNOWN, MAX_HEADROOM, exists, readJson, readText, tally, cap, mech, checkLedger, budgetLine, isPartial, isRaft, inPort } from './ledger-lib.mjs'
import { renderGrid } from './grid.mjs'

const { errors, ledger, later, retired, ids } = checkLedger()
const fail = m => errors.push(m)
const isInt = v => Number.isInteger(v)
const isStr = v => typeof v === 'string' && v.trim().length > 0
const known = new Set([...ids, ...later.filter(r => r && r.id).map(r => r.id)])
const t = tally(ledger)
const show = c => `${c.records} records, ${c.low} to ${c.high}`

// 3: the budget. It is on the record count, on the margins only: each layer, each slice and the whole.
let budget = null, slices = null, card = null
if (!exists(spec('budget.json'))) fail('spec/budget.json is missing')
else {
  try { budget = readJson(spec('budget.json')) } catch (e) { fail(`spec/budget.json: ${e.message}`) }
  if (budget) {
    const pct = budget.headroom_pct
    let whole = true
    if (!isInt(pct) || pct < 0 || pct > MAX_HEADROOM) { fail(`budget.json: headroom_pct must be a whole number from 0 to ${MAX_HEADROOM}`); whole = false }
    if (!isStr(budget.status) || !/^(proposed by card \d{4}; not yet accepted|accepted by card \d{4})$/.test(budget.status)) { fail('budget.json: status must be "proposed by card NNNN; not yet accepted" or "accepted by card NNNN"'); whole = false }
    for (const l of LAYERS) if (!isInt(budget.layers?.[l])) { fail(`budget.json: no budget for layer ${l}`); whole = false }
    for (const s of SLICES) if (!isInt(budget.slices?.[s])) { fail(`budget.json: no budget for slice ${s}`); whole = false }
    if (!isInt(budget.total)) { fail('budget.json: no total'); whole = false }
    if (!isStr(budget.card) || !/^\d{4}$/.test(budget.card)) { fail('budget.json: card must name the card that set it, as four digits'); whole = false }
    else if (isStr(budget.status) && !budget.status.includes(`card ${budget.card}`)) { fail('budget.json: status and card name different cards'); whole = false }
    if (whole) {
      for (const l of LAYERS) if (t.layers[l].records > cap(budget.layers[l], pct)) fail(`over budget: layer ${l} has ${t.layers[l].records} records; the budget is ${budget.layers[l]}, ${cap(budget.layers[l], pct)} with headroom`)
      for (const s of SLICES) if (t.slices[s].records > cap(budget.slices[s], pct)) fail(`over budget: slice ${s} has ${t.slices[s].records} records; the budget is ${budget.slices[s]}, ${cap(budget.slices[s], pct)} with headroom`)
      if (t.total.records > cap(budget.total, pct)) fail(`over budget: the ledger has ${t.total.records} records; the budget is ${budget.total}, ${cap(budget.total, pct)} with headroom`)
      // The card that set the budget holds a second copy of its numbers. A budget changed alone is caught here.
      const dir = spec('cards'), file = exists(dir) ? fs.readdirSync(dir).find(f => f.startsWith(budget.card + '-') && f.endsWith('.md')) : null
      if (!file) fail(`budget.json names card ${budget.card}, but spec/cards holds no such card`)
      else {
        card = readText(spec('cards', file))
        if (!card.split('\n').includes(budgetLine(budget))) fail(`spec/cards/${file}: its budget line is not budget.json's. Expected: ${budgetLine(budget)}`)
      }
    }
  }
}

// 4: the slice records agree with the ledger.
if (!exists(spec('slices.json'))) fail('spec/slices.json is missing')
else {
  try { slices = readJson(spec('slices.json')) } catch (e) { fail(`spec/slices.json: ${e.message}`) }
  if (slices) {
    if (!Array.isArray(slices) || slices.length !== SLICES.length) { fail('slices.json: need one record per slice, 0 to 8'); slices = null }
    else slices.forEach((s, i) => {
      if (s.slice !== i) fail(`slices.json #${i}: slice must be ${i}`)
      for (const k of ['name', 'adds', 'owner_sees', 'owner_runs']) if (!isStr(s[k])) fail(`slices.json slice ${i}: ${k} is missing`)
      for (const k of ['models', 'pins', 'data5']) if (!Array.isArray(s[k])) fail(`slices.json slice ${i}: ${k} must be a list`)
      const c = t.slices[i], r = s.rules || {}
      if (r.records !== c.records || r.low !== c.low || r.high !== c.high) fail(`slices.json slice ${i}: rules says ${JSON.stringify(r)}, the ledger says ${JSON.stringify(c)}`)
      const want = [...new Set(ledger.filter(x => x.layer === 'D' && x.slice === i).map(x => mech(x.id)))].sort()
      if (JSON.stringify([...(s.data5 || [])].sort()) !== JSON.stringify(want)) fail(`slices.json slice ${i}: data5 must be the data 5 mechanisms this slice turns on: ${JSON.stringify(want)}`)
    })
  }
}

// While the budget card is open, its picture is today's grid. Once it is accepted the card is a record and is left alone.
if (card && budget && slices && budget.status.startsWith('proposed') && !card.includes('```\n' + renderGrid(ledger, slices, budget, later) + '\n```')) fail(`the open budget card's picture is not what node tools/grid.mjs prints today`)

// 5: no page names a rule that does not exist. A rule id on a page is written in backticks: `slot-move.4`.
const pages = ['SYSTEM.md', 'SHAPES.md', 'L0.md', 'L1.md', 'L2.md', 'L3.md', 'L4.md', 'L5.md', 'README.md', 'NOTES.md'].filter(p => exists(spec(p)))
if (exists(spec('cards'))) for (const f of fs.readdirSync(spec('cards')).sort()) if (f.endsWith('.md')) pages.push('cards/' + f)
let named = 0
for (const p of pages) {
  readText(spec(p)).split('\n').forEach((line, n) => {
    for (const m of line.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[1-9][0-9]*)`/g)) {
      named++
      if (!known.has(m[1])) fail(`spec/${p}:${n + 1}: names rule ${m[1]}, which is not in the ledger`)
    }
  })
}

// The counts the pages state must be there, and must be the ledger's own.
const num = s => +s.replace(/,/g, '')
if (!exists(spec('SYSTEM.md'))) fail('spec/SYSTEM.md is missing')
else {
  const sys = readText(spec('SYSTEM.md'))
  const m = sys.match(/ledger holds ([0-9,]+) rule records \(([0-9,]+) to ([0-9,]+)/)
  if (!m) fail('spec/SYSTEM.md: the sentence "The ledger holds N rule records (low to high ..." is missing')
  else if (num(m[1]) !== t.total.records || num(m[2]) !== t.total.low || num(m[3]) !== t.total.high) fail(`spec/SYSTEM.md: says ${m[1]} records, ${m[2]} to ${m[3]}; the ledger has ${show(t.total)}`)
  const raft = ledger.filter(isRaft), r = sys.match(/carries (\d+) of the ledger's (\d+) Raft records/)
  if (!r) fail('spec/SYSTEM.md: the sentence "... carries N of the ledger\'s M Raft records" is missing')
  else if (+r[1] !== raft.filter(inPort).length || +r[2] !== raft.length) fail(`spec/SYSTEM.md: says ${r[1]} of ${r[2]} Raft records; the ledger has ${raft.filter(inPort).length} of ${raft.length}`)
  const off = raft.filter(x => inPort(x) && x.slice !== 1)
  if (off.length) fail(`a rule the Raft port carries goes on in slice 1: ${off.map(x => x.id).join(', ')}`)
}
if (!exists(spec('README.md'))) fail('spec/README.md is missing')
else {
  const lines = readText(spec('README.md')).split('\n')
  const byLayer = lines.find(l => l.startsWith('Records by layer:')), bySlice = lines.find(l => l.startsWith('Records by slice:'))
  if (!byLayer) fail('spec/README.md: the line "Records by layer:" is missing')
  else for (const l of LAYERS) { const x = byLayer.match(new RegExp(`\\b${l} (\\d+)`)); if (!x || +x[1] !== t.layers[l].records) fail(`spec/README.md: layer ${l} should read ${t.layers[l].records}`) }
  if (!bySlice) fail('spec/README.md: the line "Records by slice:" is missing')
  else for (const s of SLICES) { const x = bySlice.match(new RegExp(`\\bS${s} (\\d+)`)); if (!x || +x[1] !== t.slices[s].records) fail(`spec/README.md: slice ${s} should read ${t.slices[s].records}`) }
}

// The report.
console.log(`ledger gate`)
console.log(`  ledger   ${show(t.total)} at low and high; ${new Set(ledger.map(r => mech(r.id))).size} mechanisms`)
console.log(`  layers   ${LAYERS.map(l => `${l} ${t.layers[l].records}`).join('  ')}`)
console.log(`  slices   ${SLICES.map(s => `S${s} ${t.slices[s].records}`).join('  ')}`)
console.log(`  known    ${KNOWN.map(k => `${k} ${ledger.filter(r => r.known === k).length}`).join('  ')}; ${ledger.filter(isPartial).length} of the models are partial`)
console.log(`  proof    ${ledger.filter(r => !String(r.proof).startsWith('none-yet')).length} earned, ${ledger.filter(r => String(r.proof).startsWith('none-yet')).length} none yet`)
console.log(`  later    ${later.length} records kept for after the first build; ${retired.length} ids retired`)
console.log(`  budget   ${budget ? `${budget.status}; ${budget.total} records, ${budget.headroom_pct} % of headroom on any line` : 'missing'}`)
console.log(`  slices   ${slices ? 'spec/slices.json read' : 'spec/slices.json is missing or broken'}`)
console.log(`  pages    ${pages.join(', ') || 'none'}: ${named} rule ids named`)
if (errors.length) {
  console.log(`\nFAILED: ${errors.length} problem${errors.length === 1 ? '' : 's'}`)
  for (const e of errors.slice(0, 60)) console.log('  - ' + e)
  if (errors.length > 60) console.log(`  ... and ${errors.length - 60} more`)
  process.exit(1)
}
console.log('\nok ledger-gate')
