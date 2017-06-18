// This test spins up all the nodes together and waits for them to connect 
// Contrast with rolling.js
// TODO: This requires more convergence -> udp stops multicast after first discovery
const fero = require('fero')
    , { test } = require('tap')
    , ms = hrtime => hrtime[0] * 1e3 + hrtime[1] * 1e-6
    , { csize = 5 } = require('minimist')(process.argv)
    , timeout = 9999999
    , opts = { 
        constants: { 
          connections: { timeout }
        , outbox: { 
            frag: 2 << 10
          , max : 2 << 10 
          }
        }
      }

test(`swarm ${csize}`, { timeout }, async () => Promise.all(
  (await cluster(csize)).map(server => server.destroy())
))

async function cluster(size) {
  const servers = await Promise.all(Array(size).fill().map(d => fero('test', opts)))
  await Promise.all(servers.map((server, i) => server.on('connected').filter(d => (console.log("server.peers.lists.connected.length", i, server.peers.lists.connected.length), true)).filter(server => server.peers.lists.connected.length == size - 1)))
  return servers
}