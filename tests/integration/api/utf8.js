const fero = require('fero')
    , { test } = require('tap')

test('change with non-standard char', async ({ plan, same, ok }) => {
  plan(2)
  const server = await fero('test')
      , client = await fero('test', { client: true })

  // wait till client/server connected to each other
  await Promise.all([server.once('client'), client.once('connected')])

  // global listeners
  server.update('quote', '“')
  await client.on('change')

  same(server, { quote: '“' }, 'non-standard quote')
  same(client, { quote: '“' }, 'non-standard quote')
  
  await server.destroy()
  await client.destroy()
})

test('send/reply with non-standard char', async ({ plan, same, ok }) => {
  plan(1)
  const server = await fero('test', req => req.text())
      , client = await fero('test', { client: true })

  // wait till client/server connected to each other
  await Promise.all([server.once('client'), client.once('connected')])

  // global listeners
  const reply = await client.peers.send('“').on('reply')
  same(reply.text(), '“', 'non-standard quote')
  
  await server.destroy()
  await client.destroy()
})