// This tests adding nodes to a cluster one-by-one 
// Contrast with swarm.js
const fero = require('fero')
    , { test } = require('tap')
    , { debounce } = require('utilise/pure')
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

test(`rolling ${csize}`, { timeout }, async () => Promise.all(
  (await cluster(csize)).map(server => server.destroy())
))

async function cluster(size) {
  const servers = []

  while (servers.length < size) {
    let i = servers.length
    const server = await fero('test', opts)
    servers.push(server)
    
    const stable = server.on('connected')
      .filter(debounce((d, i, n) => n.next()))
      .filter(d => servers.every(server => server.peers.lists.connected.length === servers.length - 1))

    server.emit('connected', 'start')
    await stable
  }

  return servers
}
