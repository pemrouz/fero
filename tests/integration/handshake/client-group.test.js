const fero = require('fero')
    , { test } = require('tap')
    , { keys } = require('utilise/pure')
    , { messages = 10000 } = require('minimist')(process.argv)
    , { combine } = require('../../../utils')

test('should correctly identify client groups - default', async ({ plan, same }) => {
  plan(2)
  const server = await fero('test')
      , client = await fero('test', { client: true })
      
  const peer = await server.once('client')

  same(peer.status, 'client', 'has client status')
  same(peer.client, true, 'defaults to true')

  await server.destroy()
  await client.destroy()
})

test('should correctly identify client groups - labelled', async ({ plan, same }) => {
  plan(2)
  const server = await fero('test')
      , client = await fero('test', { client: 'monitor' })
      
  const peer = await server.once('client')

  same(peer.status, 'client', 'has client status')
  same(peer.client, 'monitor', 'set to group')

  await server.destroy()
  await client.destroy()
})