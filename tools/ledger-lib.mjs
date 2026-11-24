// Shared by ledger-gate.mjs, grid.mjs and gate-selftest.mjs. No dependencies; plain node 22.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// FERO_SPEC_DIR points the tools at another spec folder, for their own tests.
export const spec = (...p) => path.join(process.env.FERO_SPEC_DIR || path.join(root, 'spec'), ...p)
export const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'D']
export const SLICES = [0, 1, 2, 3, 4, 5, 6, 7, 8]
export const FIELDS = ['id', 'layer', 'text', 'known', 'evidence', 'touches', 'decision', 'slice', 'low', 'high', 'sites', 'tests', 'proof']
export const KNOWN = ['model', 'seeds', 'spec', 'code', 'measured', 'reasoned']
export const MAX_HEADROOM = 10

export const exists = f => fs.existsSync(f)
export const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'))
export const readText = f => fs.readFileSync(f, 'utf8')
export const mech = id => id.replace(/\.\d+$/, '')

// The count of a set of records: how many, and the sum of their low and high bounds.
export function count(records) {
  let low = 0, high = 0
  for (const r of records) { low += r.low; high += r.high }
  return { records: records.length, low, high }
}

// Counts by layer, by slice, by cell and in all.
export function tally(ledger) {
  const layers = {}, slices = {}, cells = {}
  for (const l of LAYERS) layers[l] = count(ledger.filter(r => r.layer === l))
  for (const s of SLICES) slices[s] = count(ledger.filter(r => r.slice === s))
  for (const l of LAYERS) for (const s of SLICES) cells[l + ':' + s] = count(ledger.filter(r => r.layer === l && r.slice === s))
  return { layers, slices, cells, total: count(ledger) }
}

// The most a budget line allows: its number plus the headroom, rounded down.
export const cap = (n, pct) => Math.floor(n * (100 + pct) / 100)

// A model that was run on a smaller or an older form of the rule says so at the start of its evidence.
export const isPartial = r => r.known === 'model' && typeof r.evidence === 'string' && r.evidence.startsWith('partial model: ')
// A record at low 0 names, in its evidence, the record that may already hold its rule.
export const foldsInto = r => (typeof r.evidence === 'string' && r.evidence.match(/may fold into ([a-z][a-z0-9-]*\.[1-9][0-9]*)/) || [])[1]
// Raft's records, and the ones the ported Raft's own code carries (the rest are fero's rules on top of the port).
export const isRaft = r => /^(raft-|learners\.)/.test(r.id)
export const RAFT_ON_TOP = ['raft-config.15', 'learners.3', 'raft-prevote-checkquorum.7']
export const inPort = r => isRaft(r) && !RAFT_ON_TOP.includes(r.id)

// The budget as one line of text. The card that set the budget holds the same line; the gate compares the two.
export const budgetLine = b => `budget ${b.card}: layers ${LAYERS.map(l => `${l} ${b.layers?.[l]}`).join(' ')} | slices ${SLICES.map(s => `S${s} ${b.slices?.[s]}`).join(' ')} | whole ${b.total} | headroom ${b.headroom_pct} %`

const isStr = v => typeof v === 'string' && v.trim().length > 0
const isInt = v => Number.isInteger(v)
const strList = v => Array.isArray(v) && v.every(isStr)
const ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[1-9][0-9]*$/
const SOURCE = /\bE-\d+|\.(tla|go|ts|rs|py|mjs)\b/

// The form of one record. Returns the problems found, as text.
export function checkRecord(r, i, file, later) {
  const out = [], fail = m => out.push(m)
  const at = `${file} #${i}${r && isStr(r.id) ? ' ' + r.id : ''}`
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return [`${at}: not a record`]
  const keys = Object.keys(r)
  if (keys.length !== FIELDS.length || keys.some((k, j) => k !== FIELDS[j])) fail(`${at}: fields must be exactly ${FIELDS.join(', ')}, in that order`)
  if (!isStr(r.id) || !ID.test(r.id)) fail(`${at}: id must be mechanism.number, lower-case kebab`)
  if (!LAYERS.includes(r.layer)) fail(`${at}: layer must be one of ${LAYERS.join(' ')}`)
  if (!isStr(r.text) || !/[.]$/.test(r.text.trim()) || /\n/.test(r.text)) fail(`${at}: text must be one sentence on one line, ending with a full stop`)
  else if (/[.!?] +[A-Z]/.test(r.text.trim())) fail(`${at}: text holds more than one sentence; one rule is one sentence`)
  if (!KNOWN.includes(r.known)) fail(`${at}: known must be one of ${KNOWN.join(' ')}`)
  if (r.evidence !== null && !isStr(r.evidence)) fail(`${at}: evidence must be text or null`)
  if (!strList(r.touches) || r.touches.length === 0) fail(`${at}: touches must name at least one state`)
  if (r.decision !== null && !isStr(r.decision)) fail(`${at}: decision must be text or null`)
  if (later ? r.slice !== null : !SLICES.includes(r.slice)) fail(`${at}: slice must be ${later ? 'null in later.json' : '0 to 8'}`)
  if (!isInt(r.low) || !isInt(r.high) || r.low < 0 || r.high < r.low || r.high < 1) fail(`${at}: need 0 <= low <= high and high >= 1`)
  if (!Array.isArray(r.sites) || !Array.isArray(r.tests)) fail(`${at}: sites and tests must be lists`)
  // Nothing is built, and the scan that fills sites and tests does not exist yet. So no record can have earned a proof.
  else if (r.sites.length || r.tests.length) fail(`${at}: sites and tests are filled by a scan that does not exist yet; they must be empty`)
  if (!isStr(r.proof) || !/^none-yet\(.+\)$/.test(r.proof)) fail(`${at}: proof must be none-yet(reason) until the scan and the nightly run exist`)
  // A "known" needs its evidence.
  if (KNOWN.includes(r.known) && r.known !== 'reasoned' && r.evidence === null) fail(`${at}: known "${r.known}" with no evidence`)
  else if (['model', 'seeds', 'measured'].includes(r.known) && !SOURCE.test(r.evidence)) fail(`${at}: known "${r.known}" must name an experiment (E-nn) or a model or source file in its evidence`)
  if (isStr(r.evidence) && r.evidence.startsWith('partial model: ') && r.known !== 'model') fail(`${at}: only a "model" record can be a partial model`)
  return out
}

// The form of the ledger, the later rules and the retired ids. Shared so the grid never prints a broken ledger as if it were sound.
export function checkLedger() {
  const errors = [], fail = m => errors.push(m)
  let ledger = [], later = [], retired = []
  try { ledger = readJson(spec('ledger.json')) } catch (e) { fail(`spec/ledger.json: ${e.message}`) }
  if (!Array.isArray(ledger)) { fail('spec/ledger.json: not a list'); ledger = [] }
  const ids = new Set()
  let formOk = true
  ledger.forEach((r, i) => {
    const p = checkRecord(r, i, 'ledger.json', false)
    if (p.length) formOk = false
    errors.push(...p)
    if (r && isStr(r.id)) { if (ids.has(r.id)) fail(`ledger.json #${i} ${r.id}: the id repeats`); ids.add(r.id) }
  })
  if (formOk) {
    const order = r => [LAYERS.indexOf(r.layer), mech(r.id), +r.id.replace(/^.*\./, '')]
    for (let i = 1; i < ledger.length; i++) {
      const a = order(ledger[i - 1]), b = order(ledger[i])
      if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) { fail(`ledger.json #${i} ${ledger[i].id}: out of order (by layer, then id)`); break }
    }
    // Low 0 has one meaning: a named other record may already hold this rule.
    for (const r of ledger) if (r.low === 0) {
      const to = foldsInto(r)
      if (!to) fail(`ledger.json ${r.id}: low is 0, so its evidence must say "may fold into <id>"`)
      else if (to === r.id || !ids.has(to)) fail(`ledger.json ${r.id}: may fold into ${to}, which is not another record of the ledger`)
    }
  }
  // The rules kept for after the first build: same form, no slice, no id shared with the ledger.
  if (!exists(spec('later.json'))) fail('spec/later.json is missing')
  else {
    try { later = readJson(spec('later.json')) } catch (e) { fail(`spec/later.json: ${e.message}`) }
    if (!Array.isArray(later)) { fail('spec/later.json: not a list'); later = [] }
    const seen = new Set()
    later.forEach((r, i) => {
      errors.push(...checkRecord(r, i, 'later.json', true))
      if (r && isStr(r.id)) { if (ids.has(r.id) || seen.has(r.id)) fail(`later.json #${i} ${r.id}: the id repeats`); seen.add(r.id) }
    })
  }
  // An id is never reused. A retired id is in neither file, and every hole in a mechanism's numbers is a retired id.
  if (!exists(spec('retired.json'))) fail('spec/retired.json is missing')
  else {
    try { retired = readJson(spec('retired.json')) } catch (e) { fail(`spec/retired.json: ${e.message}`) }
    if (!strList(retired) && !(Array.isArray(retired) && retired.length === 0)) { fail('spec/retired.json: must be a list of ids'); retired = [] }
    const live = new Set([...ids, ...later.filter(r => r && isStr(r.id)).map(r => r.id)]), gone = new Set(retired), max = {}
    for (const id of retired) if (live.has(id)) fail(`${id}: a retired id is used again`)
    for (const id of live) max[mech(id)] = Math.max(max[mech(id)] || 0, +id.replace(/^.*\./, ''))
    for (const m of Object.keys(max)) for (let n = 1; n <= max[m]; n++) if (!live.has(`${m}.${n}`) && !gone.has(`${m}.${n}`)) fail(`${m}.${n}: the number is skipped but not listed in retired.json`)
  }
  return { errors, ledger: formOk ? ledger : ledger.filter(r => r && typeof r === 'object' && isInt(r.low) && isInt(r.high) && isStr(r.id)), later, retired, ids, formOk }
}
