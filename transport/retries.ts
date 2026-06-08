//! Jittered, capped exponential backoff for server reconnection; next()→delay, reset() on success.
// Jittered, capped exponential backoff for server reconnection. The one legacy
// transport file (fero-old/retries.js) with no events and no JSON — a near
// verbatim port, modernized to TS with the jitter source injectable so tests
// are deterministic.
//
// Contract (from peer.ts): on a failed/dropped connection call next() to get
// the delay (ms) before redialing; on a successful connect call reset(). After
// `max` attempts, next() returns -1 — the caller destroys the peer (a client
// that can't reach its server gives up; a server keeps its own policy).

//! Tuning knobs: base/cap/max backoff plus jitter fraction and an injectable random for determinism.
export type RetryOpts = {
  base?: number // first backoff, ms
  cap?: number // max backoff, ms (the plateau)
  max?: number // attempts before giving up (Infinity = never)
  jitter?: number // fraction of backoff applied as ± random jitter (0 = none)
  random?: () => number // injectable; defaults to Math.random
}

//! Stateful backoff counter: tracks attempt #, computes next delay, reports exhausted, resets on connect.
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

  //! Delay (ms) until the next retry, advancing the attempt counter; -1 once exhausted.
  // Delay (ms) until the next retry, advancing the attempt counter. Returns -1
  // once attempts are exhausted. base·2^n capped at `cap`, then ± jitter·backoff.
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
