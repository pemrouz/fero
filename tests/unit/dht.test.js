!async function(cases){
  const { emitterify, key } = require('utilise/pure')
      , { same, equal, plan } = require('tap')
      , DHT = require('../../dht')
      , peers = emitterify({ 
          constants: { vnodes: 200 }
        , cache: emitterify()
        })
      , dht = new DHT(peers)
      , peer = { id: 'foo', uuid: '123' }

  plan(21)
  same(dht.ring.size, 0, 'init size')
  same(dht.vnodes, {}, 'init vnodes')  
  same(dht.lookup(), undefined, 'init lookup')

  peers.cache.once('checksum').map(d => same(d, 193420387, 'checksum update'))
  dht.insert(peer)
  same(dht.ring.size, 200, 'insert size')
  same(dht.vnodes.foo.length, 200, 'insert vnodes')

  dht.insert(peer)
  same(dht.ring.size, 200, 'duplicate size')
  same(dht.vnodes.foo.length, 200, 'duplicate vnodes')
  same(dht.lookup('bar'), { id: 'foo', uuid: '123' }, 'lookup')
  same(dht.lookup(), { id: 'foo', uuid: '123' }, 'lookup missing key')

  dht.remove({ id: 'foo' })
  same(dht.ring.size, 200, 'remove similar size')
  same(dht.vnodes.foo.length, 200, 'remove similar vnodes')

  dht.remove(peer)
  same(dht.ring.size, 0, 'remove exact size')
  same(dht.vnodes, [], 'remove exact vnodes')

  dht.remove('baz')
  same(dht.ring.size, 0, 'remove non-existent size')
  same(dht.vnodes, [], 'remove non-existent vnodes')

  peers.cache.emit('status', ['connected', peer])
  same(dht.ring.size, 200, 'peer connect size')
  same(dht.vnodes.foo.length, 200, 'peer connect vnodes')

  peers.cache.emit('status', ['disconnected', peer])
  same(dht.ring.size, 0, 'peer disconnect size')
  same(dht.vnodes, [], 'peer disconnect vnodes')

  peers.cache.once('checksum').map(d => same(d, 193432564, 'checksum on init'))
  peers.me = { id: 'bar', uuid: '456' }
  new DHT(peers)
}([])