// The join protocol — INIT → SYNC → DONE — bounded to ≤3 messages. v1 is
// MEMBERSHIP-ONLY: it exchanges identity (uuid, role, listen address) and
// gossips known server addresses so the mesh self-organizes into a full mesh.
// State reconciliation (per-partition heads + diff) is deferred to L1, where the
// log + a conflict rule live (see plan.md §10 / the L0 design).
//
// On-ethos: the handshake payload is carried AS a change record — one
// `{type:'update', key:[], value: Identity}` — through the same message.ts codec
// the data path uses, just under a different frame verb. No second serializer.

import { controlFrame, VERB, type Frame } from './message.ts'
import type { Peer } from './peer.ts'

export type Identity = {
  uuid: string
  role: 'server' | 'client'
  listen?: string // "host:port" this node accepts on (servers only)
  peers: string[] // known server listen addresses — gossiped so the mesh closes
}

const control = (verb: number, id: Identity) => controlFrame(verb, id)

export type HandshakeHooks = {
  identity: () => Identity // our current identity + known server addresses
  learn: (id: Identity) => void // merge a peer's identity (→ pool.add gossiped servers)
  done?: (peer: Peer, id: Identity) => void // the relationship is established
}

// The dialer kicks off the exchange once its socket connects.
export function initiate(peer: Peer, hooks: HandshakeHooks) {
  peer.write(control(VERB.INIT, hooks.identity()))
}

// Handle an inbound frame. Returns true iff it was a handshake control frame
// (so the caller knows not to treat it as a data RECORDS frame).
export function handle(frame: Frame, peer: Peer, hooks: HandshakeHooks): boolean {
  switch (frame.verb) {
    case VERB.INIT: {
      hooks.learn(identityOf(frame))
      peer.write(control(VERB.SYNC, hooks.identity())) // accepter answers
      return true
    }
    case VERB.SYNC: {
      const id = identityOf(frame)
      hooks.learn(id)
      peer.write(control(VERB.DONE, hooks.identity())) // dialer acks
      hooks.done?.(peer, id)
      return true
    }
    case VERB.DONE: {
      const id = identityOf(frame)
      hooks.learn(id)
      hooks.done?.(peer, id)
      return true
    }
    default:
      return false // RECORDS / ACK / … — not a handshake frame
  }
}

const identityOf = (frame: Frame): Identity => (frame.value as Identity) ?? { uuid: '', role: 'client', peers: [] }
