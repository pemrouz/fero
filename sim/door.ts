//! ── sim/door — the toy door: the kernel's handshake on a seeded schedule (DESIGN-DOOR §9) ──────
// The kernel takes its door as two injected functions (kernel/door.ts Door), so the sim can drive the
// WHOLE handshake — nonces, proofs, replay, forgery, the relay — with no node:crypto and no secret in
// the kernel. This is that toy: a keyed fnv (kernel/ring.ts's, fmix32-finished) chained to the proof
// length, and a nonce of 16 bytes drawn from the sim's seeded rng. It proves the PROTOCOL, never the
// cryptography (the real-TCP tier proves node:crypto's HMAC). No node: import, so site/strip.mjs's
// gate and the determinism canary (two same-seed runs, equal trace) both hold.

import { fnv } from '../kernel/ring.ts'
import { PROOF_LEN, type Door } from '../kernel/door.ts'

//! toyDoor — a door over `secret`, minting nonces from `rng` (the sim's: every draw is part of the seed).
// Two nodes with the same secret verify each other; a different secret (or none) is refused.
export const toyDoor = (secret: string, rng: () => number): Door => ({
  mac(msg: string): string {
    let out = ''
    let h = fnv(secret + '\0' + msg)
    while (out.length < PROOF_LEN) { out += h.toString(16).padStart(8, '0'); h = fnv(secret + '\0' + out) }
    return out.slice(0, PROOF_LEN)
  },
  nonce(): string {
    let s = ''
    for (let i = 0; i < 16; i++) s += Math.floor(rng() * 256).toString(16).padStart(2, '0')
    return s
  },
})
