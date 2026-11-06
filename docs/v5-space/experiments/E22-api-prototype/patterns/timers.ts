// timers — the stand-in for fero test's fake timers. API.md's World says `advance(by)` makes
// "timers, leases and TTLs fire in order", and the L5 libraries need timers (a lock renews, a
// waiting take gives up, a consumer group rebalances, a paced job sleeps). The step-1 prototype
// has no timer on the world's clock, and a real setTimeout breaks replay (PROTO.md rule 4).
//
// So, as Node's own `node:test` mock.timers does: while a world is bound, setTimeout/setInterval
// called as a simulated process become world events for that process. A ref'd timer keeps the
// world running, as a ref'd timer keeps Node alive; an unref'd one (a renewal loop) does not.
// A dead process's timers never fire; a paused one's fire late. Outside a world: the real ones.
// The libraries use plain setTimeout, as they would live. Imported first by every pattern check
// (as v4's battery is), never by a library or an example. Not part of the core (API-NOTES D1).

import { boundWorld, type World, type Proc } from '../proto/world.ts'

const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
let ids = 0

class VTimer {
  readonly #w: World; readonly #p: Proc; readonly #fn: (...a: unknown[]) => void; readonly #args: unknown[]
  readonly #every: number | null
  readonly #id = ++ids
  #at: number
  #ev: { cancel(): void } | null = null
  #hold: { resolve(v: void): void } | null = null
  #ref = true
  #done = false
  constructor(w: World, p: Proc, ms: number, fn: (...a: unknown[]) => void, args: unknown[], every: boolean) {
    this.#w = w; this.#p = p; this.#fn = fn; this.#args = args
    const d = Math.max(1, Number(ms) || 0)
    this.#every = every ? d : null
    this.#at = w.time + d
    this.#arm()
  }
  #arm(): void {
    this.#ev?.cancel()
    this.#ev = this.#w.at(this.#at, this.#p, 'timer', () => this.#fire(), !this.#ref)
    if (this.#ref && !this.#hold) this.#hold = this.#w.deferred<void>(this.#p, 'hard')
    if (!this.#ref && this.#hold) { this.#hold.resolve(); this.#hold = null }
  }
  #fire(): void {
    if (this.#done) return
    if (this.#every === null) this.#stop(); else { this.#at = this.#w.time + this.#every; this.#arm() }
    this.#fn(...this.#args)
  }
  #stop(): void { this.#done = true; this.#ev?.cancel(); this.#hold?.resolve(); this.#hold = null }
  ref(): this { if (!this.#ref && !this.#done) { this.#ref = true; this.#arm() } return this }
  unref(): this { if (this.#ref && !this.#done) { this.#ref = false; this.#arm() } return this }
  hasRef(): boolean { return this.#ref }
  refresh(): this { if (!this.#done) { this.#at = this.#w.time + (this.#every ?? 1); this.#arm() } return this }
  close(): this { this.#stop(); return this }
  [Symbol.toPrimitive](): number { return this.#id }
}

const make = (every: boolean) => (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]): any => {
  const w = boundWorld()
  if (w === null) return (every ? real.setInterval : real.setTimeout)(fn, ms, ...args)
  return new VTimer(w, w.current(), ms ?? 0, fn, args, every)
}
const clear = (t: unknown): void => {
  if (t instanceof VTimer) t.close()
  else if (t !== undefined && t !== null) real.clearTimeout(t as any)
}
globalThis.setTimeout = make(false) as typeof setTimeout
globalThis.setInterval = make(true) as typeof setInterval
globalThis.clearTimeout = clear as typeof clearTimeout
globalThis.clearInterval = clear as typeof clearInterval

/** a promise that resolves after `ms` of the caller's (virtual) time */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
