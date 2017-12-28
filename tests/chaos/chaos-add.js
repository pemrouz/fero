// 1. spin up 10 servers and 10 clients asap
// 2. fire 100 messages from each client and wait for replication
// 3. destroy everything
const { s = 10, c = 10, m = 100 } = require('minimist')(process.argv)
    , { values, keys, debounce, delay, str } = require('utilise/pure')
    , { ms, jit, merge } = require('fero/utils') 
    , { test } = require('tap')
    , fero = require('fero')
    , timeout = 9999999
    , defaults = { 
        constants: { 
          connections: { timeout }
        , restore: { wait: 0 }
        , outbox: { 
            frag: 2 << 10
          , max : 2 << 10 
          }
        }
      }

const range = size => fn => Promise.all(Array(size).fill().map(fn))

const flatten = obj => values(obj).reduce((p, v) => (p += keys(v).length, p), 0)

test(`chaos servers: ${s}, clients: ${c}, messages: ${m}`, { timeout }, async ({ plan, same, matches }) => {
  plan(m*c + s+c)

  // spin up servers and clients
  const servers = await cluster(s)
      , clients = await cluster(c, { client: true })
      , all     = [...servers, ...clients]
  
  // fire messages from each client
  await range(c)
    ((d, i) => range(m)
      ((d, j) => delay(jit(0.5)(10))
        .then(() => clients[i]
          .add({ i, j })
          .on('reply')
          .then(({ value }) => same(clients[i][value], { i, j, id: value }))
        )
      )
    )

  // assert messages from all clients replicated across all nodes
  all.every(cache => matches(cache, all[0]))

  // tear down
  await Promise.all(all.map(d => d.destroy()))
})

async function cluster(size, opts = {}) {
  const servers = await range(size)(() => fero('test', { ...opts, ...defaults }))
  await Promise.all(servers
    .map((server, i) => server
      .on('connected')
      .filter(server => opts.client ? 1 : server.peers.lists.connected.length == size - 1)
    )
  )
  return servers
}
