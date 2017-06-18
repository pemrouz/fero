// TODO
!async function(){
  const /*{ emitterify, key } = require('utilise/pure')
      , */{ same, equal, plan } = require('tap')
      , { connect, sync, done, join } = require('../../handshake')

  // plan(21)
  same(
    connect.call({ id: '1', status: 'connecting', uuid: 'uuid' })
  , 1
  , 'should not connect unless disconnected or throttled'
  )

  same(
    connect.call({ id: '2', status: 'connected', uuid: 'uuid' })
  , 1
  , 'should not connect unless disconnected or throttled'
  )

}()