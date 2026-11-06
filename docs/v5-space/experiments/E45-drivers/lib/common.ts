// common — what every gateway shares: the counters a host prints, a line splitter for text
// protocols, and the `ensure` hook a gateway calls when a tool creates something at run time
// (a JetStream stream, a Kafka topic). Gateways import only the prototype's public surface
// (../E22-api-prototype/proto/index.ts): fero() and the verbs. Nothing here reaches into L1-L3.

export type Fero = (name: string, opts?: Record<string, unknown>) => Promise<any>

/** what a host gives a gateway */
export interface GatewayEnv {
  /** fero() bound to the process the gateway runs in */
  fero: Fero
  /** open `name` on every server with these resource keys (what v5's placement does by default:
   *  "a server folds the groups it replicates, by default every server", API.md §4). A gateway
   *  calls it when a tool creates a stream or a topic. See README, finding F2. */
  ensure: (name: string, opts: Record<string, unknown>) => Promise<void>
  /** fero.id() and fero.now() of the world */
  id: () => string
  now: () => number
  /** run fn as the gateway's process (socket callbacks run outside it) */
  run: <T>(fn: () => T) => T
  /** command-line options of the host */
  opts: Record<string, string>
  stats: Stats
}

export class Stats {
  readonly ops = new Map<string, number>()
  readonly errors = new Map<string, number>()
  conns = 0
  bytesIn = 0
  bytesOut = 0
  op(name: string, n = 1): void { this.ops.set(name, (this.ops.get(name) ?? 0) + n) }
  err(code: string): void { this.errors.set(code, (this.errors.get(code) ?? 0) + 1) }
  line(): string {
    const o = [...this.ops].map(([k, v]) => `${k}=${v}`).join(' ')
    const e = [...this.errors].map(([k, v]) => `${k}=${v}`).join(' ')
    return `conns=${this.conns} in=${this.bytesIn}B out=${this.bytesOut}B ops{${o}} errors{${e}}`
  }
}

/** a FeroError's code, or 'threw' for anything else */
export const codeOf = (e: unknown): string => (e && typeof e === 'object' && 'code' in e ? String((e as any).code) : 'threw')

/** the hook a gateway uses so its replies leave in request order (RESP, etcd unary calls are
 *  ordered per connection; the NATS protocol orders PUBs per connection) */
export class InOrder {
  #q: { done: boolean; out: Buffer | string | null }[] = []
  readonly write: (b: Buffer | string) => void
  constructor(write: (b: Buffer | string) => void) { this.write = write }
  /** reserve a slot now; fill it later */
  slot(): (out: Buffer | string) => void {
    const s = { done: false, out: null as Buffer | string | null }
    this.#q.push(s)
    return (out) => { s.done = true; s.out = out; this.#drain() }
  }
  #drain(): void {
    const parts: (Buffer | string)[] = []
    while (this.#q.length > 0 && this.#q[0].done) parts.push(this.#q.shift()!.out!)
    // replies are latin1 strings (one char per byte, as values are stored): never utf8
    if (parts.length === 1) this.write(typeof parts[0] === 'string' ? Buffer.from(parts[0], 'latin1') : parts[0])
    else if (parts.length > 1) this.write(Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p))))
  }
}

/** per-connection, per-partition chains: a command waits for the previous command on the same
 *  key from the same connection, so a pipelined SET k then GET k answers as Redis would */
export class KeyChains {
  #tail = new Map<string, Promise<unknown>>()
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tail.get(key)
    const p = prev ? prev.then(fn, fn) : fn()
    const tail = p.then(() => undefined, () => undefined)
    this.#tail.set(key, tail)
    void tail.then(() => { if (this.#tail.get(key) === tail) this.#tail.delete(key) })
    return p
  }
}
