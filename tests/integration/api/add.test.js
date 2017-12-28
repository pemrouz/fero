const fero = require('fero')
    , { test } = require('tap')

test('should add by owner', async ({ plan, same }) => {
  plan(2)
  const server = await fero('test')

  same(server.add({ name: 'foo' }).on('reply'), { value: 1 }, 'owner should return same guarantee interface')
  same(server, { 1: { id: 1, name: 'foo' }}, 'record added with id')

  await server.destroy()
})

test('should add by non-owner server', async ({ plan, same }) => {
  plan(6)
  const server1 = await fero('test')
      , server2 = await fero('test')
      , servers = [server1, server2]

  await Promise.all(servers.map(d => d.once('connected.init')))

  const owner = server1.peers.owner({ key: '' }) == server1.peers.me ? server1 : server2
      , proxy = owner == server1 ? server2 : server1

  same(1, (await owner.add({ name: 'foo' }).on('reply')).value, 'commit acknowledged')
  same(owner, { 1: { name: 'foo', id: 1 }}, 'commit on owner')
  same(proxy, {}, 'commit not on other')

  same(2, (await proxy.add({ name: 'bar' }).on('reply')).value, 'commit acknowledged')
  same(owner, { 1: { name: 'foo', id: 1 }, 2: { name: 'bar', id: 2 }}, 'commit on owner')
  same(proxy, { 1: { name: 'foo', id: 1 }, 2: { name: 'bar', id: 2 }}, 'commit on proxy')

  await server1.destroy()
  await server2.destroy()
})

test('should add by client', async ({ plan, same }) => {
  plan(7)
  const server1 = await fero('test')
      , client  = await fero('test', { client: true })

  // wait till client/server connected to each other
  await Promise.all([server1.once('client'), client.once('connected')])

  // create second server, ensures client connected to first server
  const server2 = await fero('test')

  let i = 0
  
  server1.peers.dht.lookup = () => ++i == 1 ? server1.peers.me : server1.peers.lists.connected[0]
  server2.peers.dht.lookup = () => server2.peers.me

  // wait till cluster formed
  await Promise.all([server1, server2].map(d => d.once('connected.init')))

  same(1, (await client.add({ name: 'foo' }).on('reply')).value, 'commit acknowledged')
  same(client , { 1: { name: 'foo', id: 1 }}, 'commit on client')
  same(server1, { 1: { name: 'foo', id: 1 }}, 'commit on owner')
  
  same(2, (await client.add({ name: 'bar' }).on('reply')).value, 'commit acknowledged')
  same(client , { 1: { name: 'foo', id: 1 }, 2: { name: 'bar', id: 2 }}, 'commit on client')
  same(server1, { 1: { name: 'foo', id: 1 }, 2: { name: 'bar', id: 2 }}, 'commit on proxy')
  same(server2, { 1: { name: 'foo', id: 1 }, 2: { name: 'bar', id: 2 }}, 'commit on owner')

  await server1.destroy()
  await server2.destroy()
  await client.destroy()
})