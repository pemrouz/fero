const fero = require('fero')
    , { test } = require('tap')
    , { keys } = require('utilise/pure')
    , { messages = 10000 } = require('minimist')(process.argv)
    , { combine } = require('../../../utils')

test('should connect two servers', async ({  }) => {
  const server1 = await fero('test')
      , server2 = await fero('test')
      , servers = [server1, server2]

  server1.peers.dht.lookup = d => d == 'A' ? server1.peers.me : server1.peers.lists.connected[0]
  server2.peers.dht.lookup = d => d == 'B' ? server2.peers.me : server2.peers.lists.connected[0]

  await Promise.all(servers.map(d => d.once('connected')))

  // commit on own partition
  Array(messages)
    .fill()
    .map((d, i) => server1.update(`A.${i}`, 1))
    .map((d, i) => server2.update(`B.${i}`, 2)) 

  await combine(servers, 'change')
    .filter(d => server1.partitions.A && server1.partitions.B && server2.partitions.A && server2.partitions.B)
    .filter(d => server1.partitions.A.length == messages && server1.partitions.B.length == messages)
    .filter(d => server2.partitions.A.length == messages && server2.partitions.B.length == messages)

  // commit on other's partition
  Array(messages)
    .fill()
    .map((d, i) => server1.update(`B.${i}`, 3))
    .map((d, i) => server2.update(`A.${i}`, 4)) 

  await combine(servers, 'change')
    .filter(d => server1.partitions.A && server1.partitions.B && server2.partitions.A && server2.partitions.B)
    .filter(d => server1.partitions.A.length == messages*2 && server1.partitions.B.length == messages*2)
    .filter(d => server2.partitions.A.length == messages*2 && server2.partitions.B.length == messages*2)

  await server1.destroy()
  await server2.destroy()
})

test('should connect server/client', async ({  }) => {
  const server = await fero('test')
      , client = await fero('test', { client: true })

  await Promise.all([server.once('client'), client.once('connected')])

  // commit on own partition
  Array(messages)
    .fill()
    .map((d, i) => server.update(`A.${i}`, 1))
    .map((d, i) => client.update(`B.${i}`, 2)) 

  await combine([server, client], 'change')
    .filter(d => server.partitions.A && server.partitions.B && client.partitions.A && client.partitions.B)
    .filter(d => server.partitions.A.length == messages && server.partitions.B.length == messages)
    .filter(d => client.partitions.A.length == messages && client.partitions.B.length == messages)

  // commit on other's partition
  Array(messages)
    .fill()
    .map((d, i) => server.update(`B.${i}`, 3))
    .map((d, i) => client.update(`A.${i}`, 4)) 

  await combine([server, client], 'change')
    .filter(d => server.partitions.A && server.partitions.B && client.partitions.A && client.partitions.B)
    .filter(d => server.partitions.A.length == messages*2 && server.partitions.B.length == messages*2)
    .filter(d => client.partitions.A.length == messages*2 && client.partitions.B.length == messages*2)

  await server.destroy()
  await client.destroy()
})

test('should sync cache whilst connecting', async ({ same, plan }) => {
  plan(6)
  const server1 = await fero('test')

  Array(messages)
    .fill()
    .map((d, i) => server1.update(`foo${i}`, 'bar'))

  const server2 = await fero('test')
      , servers = [server1, server2]

  await Promise.all(servers.map(d => d.once('connected')))

  same(keys(server1).length, messages)
  same(keys(server2).length, messages)

  same(server1.partitions.size(), messages)
  same(server2.partitions.size(), messages)

  same(server1.peers.lists.connected.length, 1)
  same(server2.peers.lists.connected.length, 1)
  
  await server1.destroy()
  await server2.destroy()
})

test('should ff client from server', async ({ same }) => {
  const server = await fero('test')

  Array(messages)
    .fill()
    .map((d, i) => server.update(`foo${i}`, 'bar'))

  const client = await fero('test', { client: true })

  await Promise.all([server.once('client'), client.once('connected')])

  same(keys(server).length, messages)
  same(keys(client).length, messages)

  same(server.partitions.size(), messages)
  same(client.partitions.size(), messages)

  same(server.peers.lists.client.length, 1)
  same(client.peers.lists.connected.length, 1)
  
  await server.destroy()
  await client.destroy()
})

test('should not ff server from client - rewind client', async ({ same }) => {
  const server1 = await fero('test')
      , client  = await fero('test', { client: true })

  Array(messages)
    .fill()
    .map((d, i) => server1.update(`foo${i}`, 'bar'))

  await Promise.all([server1.once('client'), client.once('connected')])
  await server1.destroy()

  const server2 = global.server2 = await fero('test')
  client.peers.create(server2.peers.me.host, server2.peers.me.port)

  await Promise.all([server2.once('client'), client.once('connected')])

  same(keys(server1).length, messages)
  same(keys(server2).length, 0)
  same(keys(client).length, 0)

  same(server1.partitions.size(), messages)
  same(server2.partitions.size(), 0)
  same(client.partitions.size(), 0)

  same(server1.peers.lists.client.length, 0)
  same(server2.peers.lists.client.length, 1)
  same(client.peers.lists.connected.length, 1)

  await server2.destroy()
  await client.destroy()
})

test('should replay complex with commits', async ({ same }) => {
  const server = await fero('test')

  server.update('foo', { bar: 'baz'})

  const client = await fero('test', { client: true })

  await Promise.all([server.once('client'), client.once('connected')])

  same(server, { foo: { bar: 'baz' }})
  same(client, { foo: { bar: 'baz' }})
  
  await server.destroy()
  await client.destroy()
})
