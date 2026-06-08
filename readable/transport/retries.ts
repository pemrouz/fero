// Jittered, capped exponential backoff for server reconnection; next()→delay, reset() on success.

// Tuning knobs: base/cap/max backoff plus jitter fraction and an injectable random for determinism.
export type RetryOpts = {
  base?: number
  cap?: number
  max?: number
  jitter?: number
  random?: () => number
}

// Stateful backoff counter: tracks attempt #, computes next delay, reports exhausted, resets on connect.
export class Retries {
  #attempt = 0
  readonly base: number
  readonly cap: number
  readonly max: number
  readonly jitter: number
  readonly #random: () => number

  constructor({ base = 100, cap = 30_000, max = Infinity, jitter = 0.5, random = Math.random }: RetryOpts = {}) {
    this.base = base
    this.cap = cap
    this.max = max
    this.jitter = jitter
    this.#random = random
  }

  get attempt() {
    return this.#attempt
  }

  get exhausted() {
    return this.#attempt >= this.max
  }

  // Delay (ms) until the next retry, advancing the attempt counter; -1 once exhausted.
  next(): number {
    if (this.#attempt >= this.max) return -1
    const backoff = Math.min(this.cap, this.base * 2 ** this.#attempt)
    this.#attempt++
    if (!this.jitter) return backoff
    const spread = backoff * this.jitter
    return Math.round(backoff - spread + this.#random() * 2 * spread)
  }

  reset() {
    this.#attempt = 0
  }
}
