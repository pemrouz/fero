const fero = require('fero')
    , { test } = require('tap')
    , { combine } = require('fero/utils')

test('two servers', async ({ plan, same }) => {
  plan(4)
  const server1 = await fero('test')
      , server2 = await fero('test')
      , servers = [server1, server2]

  await Promise.all(servers.map(d => d.once('connected.init')))

  // update from server1, wait till replicated
  server1.update('foo', 'from1')
  await combine(servers, 'change')
    .filter(d => server1.foo == 'from1')
    .filter(d => server2.foo == 'from1')

  same(server1.partitions.foo.length, 1, 'server1 partitions 1')
  same(server2.partitions.foo.length, 1, 'server2 partitions 1')

  // update from server2, wait till replicated
  server2.update('foo', 'from2')
  await combine(servers, 'change')
    .filter(d => server1.foo == 'from2')
    .filter(d => server2.foo == 'from2')

  same(server1.partitions.foo.length, 2, 'server1 partitions 2')
  same(server2.partitions.foo.length, 2, 'server2 partitions 2')

  await server1.destroy()
  await server2.destroy()
})

test('server/client', async ({ plan, same }) => {
  plan(4)
  const server = await fero('test')
      , client = await fero('test', { client: true })
      , agents = [server, client]

  await Promise.all([server.once('client'), client.once('connected')])

  // update from server, wait till replicated
  server.update('foo', 'from1')
  await combine(agents, 'change')
    .filter(d => server.foo == 'from1')
    .filter(d => client.foo == 'from1')

  same(server.partitions.foo.length, 1, 'server partitions 1')
  same(client.partitions.foo.length, 1, 'client partitions 1')

  // update from client, wait till replicated
  client.update('foo', 'from2')
  await combine(agents, 'change')
    .filter(d => server.foo == 'from2')
    .filter(d => client.foo == 'from2')

  same(server.partitions.foo.length, 2, 'server partitions 2')
  same(client.partitions.foo.length, 2, 'client partitions 2')

  await server.destroy()
  await client.destroy()
})