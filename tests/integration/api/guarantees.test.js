const fero = require('fero')
    , { test } = require('tap')
    , { emitterify, keys } = require('utilise/pure')
    , from = req => emitterify()
        .on('value')
        .on('start', function(){
          this.next(1)
          this.next(2)
          this.next(3)
        })

test('reply with function', async ({ plan, same, ok }) => {
  plan(8)
  const server = await fero('test', req => { req.reply('baz') })
      , client = await fero('test', { client: true })

  // wait till client/server connected to each other
  await Promise.all([server.once('client'), client.once('connected')])

  // global listeners
  client
    .on('ack')
    .map(d => ok(d, 'global ack'))

  client
    .on('reply')
    .map(d => ok(d, 'global rely'))

  // action-specific listeners
  const ack = await client.peers.send({ foo: 'bar' }).on('ack')
  same(ack.value, 1, 'local ack')

  const reply = await client.peers.send({ foo: 'bar' }).on('reply')
  same(reply.value, 'baz', 'local reply')
  
  await server.destroy()
  await client.destroy()
})

test('reply with return value', async ({ plan, same, ok }) => {
  plan(6)
  const server = await fero('test', { from: (req, res) => 'baz', ports: [6000] })
      , client = await fero('test', { client: true, ports: [7000] })

  // wait till client/server connected to each other
  await Promise.all([server.once('client'), client.once('connected')])

  // global listeners
  client
    .on('ack')
    .map(d => ok(d, 'global ack'))

  client
    .on('reply')
    .map(d => ok(d, 'global reply'))

  // action-specific listeners
  const ack = await client.peers.send({ foo: 'bar' }).on('ack')
  same(ack.value, 1, 'local ack')

  const reply = await client.peers.send({ foo: 'bar' }).on('reply')
  same(reply.value, 'baz', 'local reply')
  
  await server.destroy()
  await client.destroy()
})

test('reply with promise', async ({ plan, same, ok }) => {
  plan(1)
  const server = await fero('test', { from: async (req, res) => 'baz', ports: [6000] })
      , client = await fero('test', { client: true, ports: [7000] })

  // wait till client/server connected to each other
  await Promise.all([server.once('client'), client.once('connected')])

  const reply = await client.peers.send({ foo: 'bar' }).on('reply')
  same(reply.value, 'baz', 'local reply')
  
  await server.destroy()
  await client.destroy()
})

test('reply with stream', async ({ plan, same, ok, notOk }) => {
  plan(3)
  const server = await fero('test', { from, ports: [6000] })
      , client = await fero('test', { client: true, ports: [7000] })

  // wait till client/server connected to each other
  await Promise.all([server.once('client'), client.once('connected')])

  // aggregate replies
  const reply = client.peers
    .send({ foo: 'bar' })
    .on('reply')
    .reduce((acc = 0, v) => acc += v.value)
    .filter(acc => acc == 6)

  same(await reply, 6, 'aggregated replies')
  
  // assert properly unsubscribed
  ok(server.peers.lists.all[0].subscriptions['1'], 'started')
  await Promise.all(reply.source.emit('stop'))
  notOk(server.peers.lists.all[0].subscriptions['1'], 'stopped')

  await server.destroy()
  await client.destroy()
})

test('reply with stream (brokered subscription)', async ({ plan, same, ok, notOk }) => {
  plan(5)
  const server1 = await fero('test')
      , client  = await fero('test', { client: true })

  // wait till client/server connected to each other
  await Promise.all([server1.once('client'), client.once('connected')])

  // create second server, ensures client connected to first server
  const server2 = await fero('test', from)
  server1.peers.dht.lookup = d => server1.peers.lists.connected[0]
  server2.peers.dht.lookup = d => server2.peers.me

  // wait till cluster formed
  await Promise.all([server1, server2].map(d => d.once('connected.init')))

  // aggregate replies
  const reply = client.peers
    .send({ foo: 'bar' })
    .on('reply')
    .reduce((acc = 0, v) => acc += v.value)
    .filter(acc => acc == 6)

  same(await reply, 6, 'aggregated replies')
  
  notOk(keys(server1.peers.lists.all[0].subscriptions).length, 'not subscribed on 1')
  ok(keys(server2.peers.lists.all[0].subscriptions).length, 'subscribed on 2')

  await Promise.all(reply.source.emit('stop'))

  notOk(keys(server1.peers.lists.all[0].subscriptions).length, 'not subscribed on 1')
  notOk(keys(server2.peers.lists.all[0].subscriptions).length, 'not subscribed on 2')

  await server1.destroy()
  await server2.destroy()
  await client.destroy()
})