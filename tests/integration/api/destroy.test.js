const fero = require('fero')
    , { test } = require('tap')
    , { delay } = require('utilise/pure')

test('should clear all active handles', async ({ plan, same }) => {
  plan(1)
  const before = process._getActiveHandles().length
      , server = await fero('test')
      , client = await fero('test', { client: true })

  await Promise.all([server.once('client'), client.once('connected')])

  await server.destroy()
  await client.destroy()
  await delay(1000)

  // The +1 is to account for the delay timeout
  same(process._getActiveHandles().length, before + 1, 'all active handles cleared')  
})