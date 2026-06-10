// Join protocol INIT→SYNC→DONE (≤3 msgs): v1 exchanges identity + gossips server addrs into a full mesh

import { controlFrame, VERB, FrameError, type Frame } from './message.ts'
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

// Pull + VALIDATE the Identity carried as the frame's value: null/absent degrades to a minimal client id; a wrong-typed shape is a wire fault (FrameError → peer drop), never a TypeError.
const identityOf = (frame: Frame): Identity => {
  const v = frame.value as Record<string, unknown> | null | undefined
  if (v == null) return { uuid: '', role: 'client', peers: [] }
  if (
    typeof v !== 'object' ||
    Array.isArray(v) ||
    typeof v.uuid !== 'string' ||
    (v.role !== 'server' && v.role !== 'client') ||
    (v.listen !== undefined && typeof v.listen !== 'string')
  )
    throw new FrameError('malformed handshake identity')
  const peers = v.peers === undefined ? [] : v.peers
  if (!Array.isArray(peers)) throw new FrameError('malformed handshake identity (peers is not a list)')
  for (const p of peers) if (typeof p !== 'string') throw new FrameError('malformed handshake identity (non-string peer address)')
  return { uuid: v.uuid, role: v.role, listen: v.listen as string | undefined, peers: peers as string[] }
}
