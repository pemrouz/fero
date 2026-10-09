//! ── sim/door — the toy door: the kernel's handshake on a seeded schedule (DESIGN-DOOR §9) ──────
// The kernel takes its door as injected functions (kernel/door.ts Door), so the sim can drive the WHOLE
// handshake — nonces, proofs, replay, forgery, the relay, the client key — with no node:crypto and no
// secret in the kernel. This is that toy: a keyed fnv (kernel/ring.ts's, fmix32-finished) chained to the
// proof length, and a nonce of 16 bytes drawn from the sim's seeded rng. It proves the PROTOCOL, never
// the cryptography (the real-TCP tier proves node:crypto's HMAC). No node: import, so site/strip.mjs's
// gate and the determinism canary (two same-seed runs, equal trace) both hold.

import { fnv } from '../kernel/ring.ts'
import { PROOF_LEN, type Door } from '../kernel/door.ts'

//! toyMac — the keyed toy MAC over `key`: a chained fnv, PROOF_LEN hex characters. Pure: no rng.
const toyMac = (key: string) => (msg: string): string => {
  let out = ''
  let h = fnv(key + '\0' + msg)
  while (out.length < PROOF_LEN) { out += h.toString(16).padStart(8, '0'); h = fnv(key + '\0' + out) }
  return out.slice(0, PROOF_LEN)
}
//! toyNonce — 16 bytes as hex, drawn from `rng` (the sim's: every draw is part of the seed)
const toyNonce = (rng: () => number) => (): string => {
  let s = ''
  for (let i = 0; i < 16; i++) s += Math.floor(rng() * 256).toString(16).padStart(2, '0')
  return s
}

//! toyClientKey — the toy's derived client key (§15): the toy MAC of the secret over the same label the
// api uses, so a client that holds only this string can follow a member that holds the secret.
export const toyClientKey = (secret: string): string => toyMac(secret)('fero/client/1')

//! toyDoor — a MEMBER's door (or a client's that holds the secret) over `secret`: mac signs member links,
// clientMac (derived) signs client links. Two nodes with the same secret verify each other; a different
// secret (or none) is refused.
export const toyDoor = (secret: string, rng: () => number): Door =>
  ({ mac: toyMac(secret), clientMac: toyMac(toyClientKey(secret)), nonce: toyNonce(rng) })

//! toyClientDoor — a CLIENT-ONLY door (§15): the process holds the client key and nothing else, so every
// proof it can make is a client-key proof — mac and clientMac are one function. Without `r: 1` on its
// HELLO a member checks its proof with the secret and refuses it bad-proof.
export const toyClientDoor = (clientKey: string, rng: () => number): Door =>
  ({ mac: toyMac(clientKey), clientMac: toyMac(clientKey), nonce: toyNonce(rng) })
