const fero = require('fero')
    , { test } = require('tap')
    , { values } = require('utilise/pure')

test('should be able to create multiple fast moving peers without conflict', async ({ same, plan }) => {
  // immediately commit on server 1 after creating
  const server1 = await fero('test')
  server1.update('server1', 1)
  
  const client = await fero('test', { client: true })
  await client.once('connected')  

  // immediately commit on server 2 after committing
  const server2 = await fero('test')
  await server2.once('connected')

  same(server2.peers.lists.connected.length, 1, 'server2 connected on init')
  server2.update('server2', 1)

  // client should have received commits from both servers
  await client.once('change')
  same(server1, { server1: 1, server2: 1 }, 'server1 consistent')
  same(server2, { server1: 1, server2: 1 }, 'server2 consistent')
  same(client , { server1: 1, server2: 1 }, 'client consistent')

  // kill server 2
  await server2.destroy()

  // replacement server should pick up where previous node left off 
  const server3 = await fero('test')
  await server3.once('connected')

  same(server3.peers.lists.connected.length, 1, 'server3 connected on init')
  server3.update('server2', server3.server2 + 1)

  // client should be in sync
  await client.once('change')
  same(server1, { server1: 1, server2: 2 }, 'server1 consistent')
  same(server3, { server1: 1, server2: 2 }, 'server2 consistent')
  same(client , { server1: 1, server2: 2 }, 'client consistent')

  await Promise.all([server1.destroy(), server3.destroy(), client.destroy()])
})