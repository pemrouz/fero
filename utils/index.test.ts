//! Tier-3: the #utils port helpers over real sockets — the one place a port number's RANGE is a promise.
import './battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import net from 'node:net'
import { ports } from '#utils'

test("ports.outside() hands a bindable port in 20000-32767 — below Linux's ephemeral range, so a bind-0 pick made later (a check's member port) can never equal it", async () => {
  const seen = new Set<number>()
  for (let i = 0; i < 25; i++) {
    const p = await ports.outside()
    assert.ok(Number.isInteger(p) && p >= 20000 && p <= 32767, `${p} is in 20000-32767`)
    seen.add(p)
  }
  assert.ok(seen.size > 1, 'drawn at random, not one fixed number')
  //! the promise itself, against the box: every port is below the ephemeral floor, where bind-0 draws
  const range = (() => { try { return fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number) } catch { return null } })()
  if (range) for (const p of seen) assert.ok(p < range[0], `${p} is below the ephemeral floor ${range[0]}`)
  //! bindable: the number is free right now
  const p = await ports.outside()
  const s = net.createServer()
  await new Promise<void>((resolve, reject) => s.once('error', reject).listen(p, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => s.close(() => resolve()))
})
