const fero = require('fero')
    , { test } = require('tap')
    
test('commit - two servers', async ({ plan, same }) => {
  const server1 = await fero('test', { multicast: { type: 'tcp' }})
      , server2 = await fero('test', { multicast: { type: 'tcp' }})
      , servers = [server1, server2]

  await Promise.all(servers.map(d => d.once('connected.init')))  
  await server1.destroy()
  await server2.destroy()
})

test('commit - server/client', async ({ plan, same }) => {
  plan(0)
  const server = await fero('test', { multicast: { type: 'tcp' }})
      , client = await fero('test', { multicast: { type: 'tcp' }, client: true })
      , agents = [server, client]

  await Promise.all([server.once('client'), client.once('connected')])
  await server.destroy()
  await client.destroy()
})