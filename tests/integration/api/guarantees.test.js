const fero = require('fero')
    , { test } = require('tap')

test('reply with function', async ({ plan, same, ok }) => {
  plan(6)
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
  same(reply.text(), 'baz', 'local reply')
  
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
  same(reply.text(), 'baz', 'local reply')
  
  await server.destroy()
  await client.destroy()
})