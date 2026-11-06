// errors — the one error class (API.md §5): `code` says what, `outcome` says whether it may have
// committed, `hint` says the fix.

export type Code =
  | 'conflict' | 'fenced' | 'absent-row' | 'absent-path' | 'sparse-hole' | 'invalid-key' | 'unencodable'
  | 'too-large' | 'cross-partition' | 'no-rows' | 'schema' | 'invalid' | 'rule' | 'rule-threw' | 'rule-timeout'
  | 'methods-only' | 'forbidden' | 'call-diverged' | 'read-only' | 'disk-full' | 'backpressure'
  | 'shortfall' | 'holistic' | 'expired' | 'unknown-log' | 'schema-changed'
  | 'no-method' | 'threw' | 'busy'
  | 'timeout' | 'unknown' | 'destroyed'
  | 'locked' | 'limited' | 'no-answerer'
  | 'config' | 'node-config' | 'config-differs' | 'too-many-resources' | 'admin-only' | 'stale-plan'
  | 'dir-held' | 'wrong-project' | 'wrong-cluster' | 'no-server-here' | 'unbound'
  | 'no-writer' | 'moved' | 'retry' | 'wrong-group' | 'stale-attempt' | 'empty'

/** Codes the client acts on by itself: it retries. An app sees them only as a timeout's `cause`. */
export const INTERNAL: ReadonlySet<Code> = new Set(['no-writer', 'moved', 'retry', 'wrong-group', 'stale-attempt', 'empty'])
const UNKNOWN: ReadonlySet<Code> = new Set(['timeout', 'unknown', 'destroyed'])

const HINTS: Partial<Record<Code, string>> = {
  conflict: 'a condition failed or a bound would be crossed: read the row again and decide afresh',
  fenced: 'your lock token is older than one this writer has seen: stop acting, you no longer hold the lock',
  'absent-row': 'write the whole row first, then its fields',
  'absent-path': 'write the parent field first',
  'sparse-hole': 'write the spliced array instead of removing an element',
  unencodable: 'send plain data: objects, arrays, strings, finite numbers, booleans, null',
  'too-large': 'a record is at most 1 MB, a row at most 64 MB',
  'cross-partition': 'a batch must stay inside one partition; use saga() across partitions',
  'no-rows': 'this resource keeps no rows (rows: false): ops, claims and conditions need rows',
  'methods-only': 'this resource has methods: change its data through them',
  shortfall: 'this process does not hold that partition: use get(key) or follow([key]) first',
  holistic: 'this process holds only part of the resource: open a server view or follow the whole resource',
  expired: 'the cursor is older than the kept history: start again from err.earliest',
  timeout: 'no definite answer in time; cluster.writes.lookup(attempt) tells how it ended',
  'no-method': 'no method of that name on the server',
  'unknown-log': 'the cursor belongs to another resource or an older incarnation',
}

export class FeroError extends Error {
  readonly code: Code
  readonly outcome: 'refused' | 'unknown'
  readonly resource: string
  readonly key?: readonly (string | number)[]
  readonly attempt?: string
  readonly retryAfter?: number
  readonly current?: string
  readonly earliest?: string
  readonly path?: readonly PropertyKey[]
  readonly reason?: string
  readonly cause?: Code
  readonly hint: string
  constructor(code: Code, f: Partial<Omit<FeroError, 'code' | 'outcome' | 'hint' | 'name' | 'message'>> & { message?: string } = {}) {
    super(`fero: ${code}${f.resource ? ` (${f.resource}${f.key ? ' ' + JSON.stringify(f.key) : ''})` : ''}${f.reason ? ': ' + f.reason : ''}${f.message ? ': ' + f.message : ''}`)
    this.name = 'FeroError'
    this.code = code
    this.outcome = UNKNOWN.has(code) ? 'unknown' : 'refused'
    this.resource = f.resource ?? ''
    if (f.key !== undefined) this.key = f.key
    if (f.attempt !== undefined) this.attempt = f.attempt
    if (f.retryAfter !== undefined) this.retryAfter = f.retryAfter
    if (f.current !== undefined) this.current = f.current
    if (f.earliest !== undefined) this.earliest = f.earliest
    if (f.path !== undefined) this.path = f.path
    if (f.reason !== undefined) this.reason = f.reason
    if (f.cause !== undefined) this.cause = f.cause
    this.hint = HINTS[code] ?? ''
  }
}

/** A refusal as it travels inside fero (a plain object, as on the wire). */
export interface Refusal { code: Code; current?: string; reason?: string; path?: readonly PropertyKey[]; retryAfter?: number; earliest?: string }
export const toError = (r: Refusal, resource: string, key?: readonly (string | number)[], attempt?: string): FeroError =>
  new FeroError(r.code, { resource, key, attempt, current: r.current, reason: r.reason, path: r.path, retryAfter: r.retryAfter, earliest: r.earliest })
