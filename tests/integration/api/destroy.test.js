const fero = require('fero')
    , { test } = require('tap')
    , { delay } = require('utilise/pure')

test('should clear all active handles on single node', async ({ plan, same }) => {
  plan(1)
  const server = await fero('test')

  await server.destroy()
  await delay(1000)

  same(process._getActiveHandles().length, 3, 'all active handles are eventually cleared')  
})

test('should clear all active handles', async ({ plan, same }) => {
  plan(1)
  const server = await fero('test')
      , client = await fero('test', { client: true })

  await Promise.all([server.once('client'), client.once('connected')])

  await server.destroy()
  await client.destroy()
  await delay(1000)

  same(process._getActiveHandles().length, 3, 'all active handles are eventually cleared')  
})