// Day 0 demo — side B (the replica).
//
//   node --experimental-strip-types day0/server.ts
//   # then, in another terminal:
//   node --experimental-strip-types day0/client.ts
//
// Listens on a TCP port, builds an empty $() per connection, and replays every
// change record the client sends. It never parses fero anything — it just
// applies `data` change records and prints the resulting state.

import net from 'node:net'
import { $ } from '../../data/index.ts'
import { subscribe, value } from './replicate.ts'

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5170)

const server = net.createServer((socket) => {
  console.log('[B] client connected')
  const replica = $(undefined)
  subscribe(replica, socket, (change) => {
    console.log(`[B] ${change.type.padEnd(6)} ${JSON.stringify(change.key ?? [])}` +
      `  →  ${JSON.stringify(replica[value])}`)
  })
  socket.on('close', () => console.log('[B] client disconnected'))
})

server.listen(PORT, () => console.log(`[B] replica listening on localhost:${PORT}`))
