// Static discovery: emit host×port (+optional #broker) as candidate inserts into a self-filtered $() proxy.

import { $ } from '../../../data/index.ts'

// Config: host/port grid + optional well-known broker; `me` is our own address to exclude.
export type StaticOpts = {
  hosts?: string[]
  ports?: number[]
  broker?: { host: string; port: number }
  me?: string // own "host:port" — never emit ourselves as a candidate
}

// One dial target: "host:port" address plus its split components.
export type Candidate = { address: string; host: string; port: number }

// Build the candidate $() proxy: cross hosts×ports (+broker), self-filter, return for the pool to tap.
export function staticDiscovery({ hosts = ['127.0.0.1'], ports = [], broker, me }: StaticOpts): any {
  const candidates = $({})
  // upsert a candidate keyed by address, skipping our own — re-emit is idempotent.
  const emit = (host: string, port: number) => {
    const address = `${host}:${port}`
    if (address === me) return
    candidates[address] = { address, host, port }
  }
  for (const host of hosts) for (const port of ports) emit(host, port)
  if (broker) emit(broker.host, broker.port)
  return candidates
}
