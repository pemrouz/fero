// Static discovery: the non-multicast rendezvous path, the sensible default for
// cloud/WSL2 where IPv4 multicast is dropped. Emits the cartesian host×port
// space (plus an optional well-known #broker) as candidate `insert` records into
// a $() proxy keyed by "host:port", self-filtered. The pool taps this proxy and
// dials; staggering/rate-limiting dials is the pool's job, not discovery's.
//
// A #broker is just a well-known static candidate (`{ host, port }`) — no special
// code path, exactly as the L0 design calls for.

import { $ } from '../../../data/index.ts'

export type StaticOpts = {
  hosts?: string[]
  ports?: number[]
  broker?: { host: string; port: number }
  me?: string // own "host:port" — never emit ourselves as a candidate
}

export type Candidate = { address: string; host: string; port: number }

export function staticDiscovery({ hosts = ['127.0.0.1'], ports = [], broker, me }: StaticOpts): any {
  const candidates = $({})
  const emit = (host: string, port: number) => {
    const address = `${host}:${port}`
    if (address === me) return
    candidates[address] = { address, host, port } // upsert — re-emit is a no-op
  }
  for (const host of hosts) for (const port of ports) emit(host, port)
  if (broker) emit(broker.host, broker.port)
  return candidates
}
