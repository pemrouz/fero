!async function(cases){
  const { emitterify, key } = require('utilise/pure')
      , { same, equal, plan } = require('tap')
      , { serialise, deserialise } = require('../../serdes')
      , Peer = require('../../peer')
      , Constants = require('../../constants')
      , peers = emitterify({ 
          serialise
        , deserialise
        , cache: emitterify()
        , constants: new Constants()
        , me: false
        , disconnected: {}
        , connecting: {}
        , connected: {}
        , throttled: {}
        , client: {}
        , lists: {}
        })
      , peer = new Peer(peers, '1.2.3.4', '5678')

  // plan(23)

  // init props
  same(peer.host   , '1.2.3.4', 'host')
  same(peer.port   , '5678', 'port')
  same(peer.address, '1.2.3.4:5678', 'address')
  same(peer.id     , '1-2-3-4:5678', 'id')
  same(peer.status , 'disconnected', 'status')
  same(peer.server , false, 'server')
  same(peer.retry  , 0, 'retry')

  // TODO
}()