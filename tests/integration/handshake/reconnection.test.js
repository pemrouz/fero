const fero = require('fero')
    , { test } = require('tap')

test('should fast-forward right', async ({ same, plan }) => {
  plan(10)
  const server1 = await fero('test', { ports: [5001] })
      , server2 = await fero('test', { ports: [5002] })
      , servers = [server1, server2]

  server1.peers.dht.lookup = d => server1.peers.me
  server2.peers.dht.lookup = d => server2.peers.lists.connected[0]

  await Promise.all(servers.map(d => d.once('connected')))
  
  for (peer of server1.peers)
    server1.peers.remove(peer)

  server1.update('foo1', 'bar')
  server1.update('foo2', 'bar')
  server1.update('foo3', 'bar')

  await Promise.all(servers.map(d => d.once('connected')))

  same(server1, { foo1: 'bar', foo2: 'bar', foo3: 'bar' })
  same(server2, { foo1: 'bar', foo2: 'bar', foo3: 'bar' })

  same(server1.partitions.foo1.length, 1)
  same(server1.partitions.foo2.length, 1)
  same(server1.partitions.foo3.length, 1)

  same(server2.partitions.foo1.length, 1)
  same(server2.partitions.foo2.length, 1)
  same(server2.partitions.foo3.length, 1)

  same(server1.peers.lists.connected.length, 1)
  same(server2.peers.lists.connected.length, 1)
  
  await server1.destroy()
  await server2.destroy()
})

test('should fast-forward left', async ({ same, plan }) => {
  plan(10)
  const server1 = await fero('test', { ports: [6001] })
      , server2 = await fero('test', { ports: [6002] })
      , servers = [server1, server2]

  server1.peers.dht.lookup = d => server1.peers.me
  server2.peers.dht.lookup = d => server2.peers.lists.connected[0]

  await Promise.all(servers.map(d => d.once('connected')))

// console.log("b", '\n', server1.peers, '\n', server2.peers)
// console.log("before remove")  
  for (peer of server2.peers)
    server2.peers.remove(peer)
// console.log("after remove")
  server1.update('foo1', 'bar')
  server1.update('foo2', 'bar')
  server1.update('foo3', 'bar')

// console.log("update done", server1.partitions, server2.partitions)

  await Promise.all(servers.map(d => d.once('connected')))
  // await Promise.all(servers.map(d => d.once('connected').then(g => console.log("d", d == server1, '\n', server1.peers, '\n', server2.peers, '\n', server1.partitions, '\n', server2.partitions))))

  same(server1, { foo1: 'bar', foo2: 'bar', foo3: 'bar' })
  same(server2, { foo1: 'bar', foo2: 'bar', foo3: 'bar' })

  same(server1.partitions.foo1.length, 1)
  same(server1.partitions.foo2.length, 1)
  same(server1.partitions.foo3.length, 1)

  same(server2.partitions.foo1.length, 1)
  same(server2.partitions.foo2.length, 1)
  same(server2.partitions.foo3.length, 1)

  same(server1.peers.lists.connected.length, 1)
  same(server2.peers.lists.connected.length, 1)
  
  await server1.destroy()
  await server2.destroy()
})

// test('should handle messages during reconnect and resync', async ({ test }) => {
//   [10, 100000]
//     .map(async messages => await test(`messages ${messages}`, async () => {
//       const server1 = await fero('test')
//           , server2 = await fero('test')
//           , servers = [server1, server2]

//       // TODO: Create mock DHT to pass in constructor, rather than overwrite one function
//       // this makes server1 the the master for all partiions
//       server1.peers.dht.lookup = d => server1.peers.me
//       server2.peers.dht.lookup = d => server2.peers.lists.connected[0]

//       await Promise.all(servers.map(d => d.on('connected')))

//       // initialise arrays
//       server1.update('test1', []) // for before disconnection
//       server1.update('test2', []) // for during disconnection
//       server1.update('test3', []) // for after reconnected

//       // wait till replicated
//       await server2
//         .on('change')
//         .filter(d => server2.test1 && server2.test2 && server2.test3)

//       // fill test1[]
//       Array(messages)
//         .fill()
//         .map((d, i) => server1.push('test1', i))

//       // await replicated
//       await server2
//         .on('change')
//         .filter(d => server2.test1.length == messages)

//       // disconnect server2
//       for (peer of server2.peers)
//         server2.peers.remove(peer)

//       // keep adding messages to test2[] whilst server2 down
//       const records = await spin(done => {
//         server1.push('test2', 'foo')

//         // once reconnected, fill test3[] and resolve
//         if (server1.peers.lists.connected.length && server2.peers.lists.connected.length) {
//           Array(messages).fill().map((d, i) => server1.push('test3', i))
//           done(server2.test2.length) 
//         }
//       })

//       // await replicated
//       await server2
//         .on('change')
//         .filter(d => server1.test2.length == server2.test2.length)
//         .filter(d => server1.test3.length == server2.test3.length && server1.test3.length == messages)

//       await server1.destroy()
//       await server2.destroy()
//     }))
// })

// // TODO: refactor into utilise
// const spin = (ms, fn) => new Promise(resolve => {
//   const timer = setInterval(d => (fn || ms)(d => (clearTimeout(timer), resolve(d)) ), fn ? ms : 0)
// })