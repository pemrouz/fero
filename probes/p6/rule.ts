// The rule marker, in TypeScript.
//
// A rule is one record of the ledger (spec/ledger.json). The code that holds a rule is
// wrapped in one call with the rule's id, so the scan (tools/rule-scan.mjs) can list where
// each rule lives, and a test run can switch one rule off.
//
//   rule('fence-tokens.2', () => { fences.set(lock, token) })           a block: off skips it
//   if (rule('shape-rule.1', () => parent === null, false)) return ...   a guard: off lets all through
//   const t = rule('writer-time.3', () => Math.max(c, last), c)          a value: off gives the plain value
//
// So "switched off" means one thing: the body is not run, and the third argument stands in
// for it (nothing, for a block).
//
// Cost when no rule is off: the call, one compare, and the body's call.
// This file reads nothing from the system. A test run switches a rule off with switchOff(id);
// rule-env.ts does that from the RULE_OFF environment variable.
//
// This file lives with probe P6 for now. It moves to the server's TypeScript tree (BUILD 2.1,
// `server/`) when slice 1 makes that tree; the scan already reads every .ts file it is given.

let off = ''
let hits = 0

export function rule(id: string, body: () => void): void
export function rule<T>(id: string, body: () => T, offValue: T): T
export function rule<T>(id: string, body: () => T, offValue?: T): T | undefined {
  if (off !== '' && id === off) { hits++; return offValue }
  return body()
}

/** Switch one rule off, by id. It stays off until switchAllOn(). */
export const switchOff = (id: string): void => { off = id; hits = 0 }
/** Switch every rule back on. */
export const switchAllOn = (): void => { off = '' }
/** How many times the switched-off rule's marker was reached. */
export const offHits = (): number => hits
