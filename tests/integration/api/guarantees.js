const fero = require('fero')
    , { test } = require('tap')

test('reply with function', async ({ plan, same, ok }) => {
  plan(6)
  const server = await fero('test', req => { req.reply('baz') })
      , client = await fero('test', { client: true })

  // wait till client/server connected to each other
  await Promise.all([server.on('client'), client.on('connected')])

  // global listeners
  client
    .on('ack')
    .map(ok)

  client
    .on('reply')
    .map(ok)

  // action-specific listeners
  const ack = await client.peers.send({ foo: 'bar' }).on('ack')
  same(ack, 1)

  const reply = await client.peers.send({ foo: 'bar' }).on('reply')
  same(reply.text(), 'baz')
  
  await server.destroy()
  await client.destroy()
})

test('reply with function', async ({ plan, same, ok }) => {
  plan(6)
  const server = await fero('test', (req, res) => 'baz')
      , client = await fero('test', { client: true })

  // wait till client/server connected to each other
  await Promise.all([server.on('client'), client.on('connected')])

  // global listeners
  client
    .on('ack')
    .map(ok)

  client
    .on('reply')
    .map(ok)

  // action-specific listeners
  const ack = await client.peers.send({ foo: 'bar' }).on('ack')
  same(ack, 1)

  const reply = await client.peers.send({ foo: 'bar' }).on('reply')
  same(reply.text(), 'baz')
  
  await server.destroy()
  await client.destroy()
})