const fero = require('fero')
    , { test } = require('tap')
    , { emitterify } = require('utilise/pure')
    , from = req => emitterify()
        .on('value')
        .on('start', function(){
          this.next(1)
          this.next(2)
          this.next(3)
        })

test('should send/receive on local node', async ({ plan, same }) => {
  plan(1)
  const server = await fero('test', req => req.value.foo + 'bar')

  const reply = await server.peers.accept({ type: 'type', foo: 'foo' }).on('reply')
  same(reply.value, 'foobar')

  await server.destroy()
})

test('should start/stop stream', async ({ plan, same, ok, notOk }) => {
  plan(3)
  const server = await fero('test', from)

  // aggregate replies
  const reply = server.peers
    .accept({ foo: 'foo' })
    .on('reply')
    .reduce((acc = 0, v) => acc += v.value)
    .filter(acc => acc == 6)

  same(await reply, 6, 'aggregated replies')
  
  // assert properly stopped
  ok(server.peers.me.subscriptions['1'], 'started')
  await Promise.all(reply.source.emit('stop'))
  notOk(server.peers.me.subscriptions['1'], 'stopped')

  await server.destroy()
})