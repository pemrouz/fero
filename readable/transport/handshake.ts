// Join protocol INIT→SYNC→DONE (≤3 msgs): v1 exchanges identity + gossips server addrs into a full mesh

import { controlFrame, VERB, type Frame } from './message.ts'
import type { Peer } from './peer.ts'

// What a node advertises about itself: uuid, role, listen address, and the server addrs it knows
export type Identity = {
  uuid: string
  role: 'server' | 'client'
  listen?: string
  peers: string[]
}

const control = (verb: number, id: Identity) => controlFrame(verb, id)

// Callbacks the transport supplies: produce our identity, merge a peer's, mark the link established
export type HandshakeHooks = {
  identity: () => Identity
  learn: (id: Identity) => void
  done?: (peer: Peer, id: Identity) => void
}

// The dialer kicks off the exchange once its socket connects.
export function initiate(peer: Peer, hooks: HandshakeHooks) {
  peer.write(control(VERB.INIT, hooks.identity()))
}

// Drive the state machine on an inbound frame; returns true iff it was a handshake control frame
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
      peer.write(control(VERB.DONE, hooks.identity())) // dialer acks, then the link is established
      hooks.done?.(peer, id)
      return true
    }
    // terminal step on the accepter: learn the dialer's id and mark the relationship established
    case VERB.DONE: {
      const id = identityOf(frame)
      hooks.learn(id)
      hooks.done?.(peer, id)
      return true
    }
    default:
      return false // RECORDS / ACK / … — not a handshake frame, leave it to the data path
  }
}

// Pull the Identity carried as the frame's change-record value; fall back to a minimal client id if absent
const identityOf = (frame: Frame): Identity => (frame.value as Identity) ?? { uuid: '', role: 'client', peers: [] }
