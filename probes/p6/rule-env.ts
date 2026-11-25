// The test side of the TypeScript marker: load it first (node --import ./rule-env.ts).
// It switches off the rule named by RULE_OFF. When the process ends and that rule's marker
// was reached at least once, it makes the empty file named by RULE_HIT_FILE, so a runner can
// tell "no test reaches this rule" from "tests reach it and stay green".
import { writeFileSync } from 'node:fs'
import { switchOff, offHits } from './rule.ts'

const id = process.env.RULE_OFF
if (id) {
  switchOff(id)
  const file = process.env.RULE_HIT_FILE
  if (file) process.on('exit', () => { if (offHits() > 0) writeFileSync(file, '') })
}
