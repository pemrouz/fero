!async function(cases){
  const { emitterify, key } = require('utilise/pure')
      , { same, equal, plan } = require('tap')
      , { serialise, deserialise } = require('../../serdes')
      , Partitions = require('../../partitions')
      , Constants = require('../../constants')
      , broadcast = []
      , multicast = []
      , peers = emitterify({ 
          serialise
        , deserialise
        , cache: emitterify()
        , constants: new Constants()
        , me: false
        , broadcast: (change, command) => broadcast.push({ change, command })
        , multicast: (change, command) => multicast.push({ change, command })
        })
      , partitions = new Partitions(peers)

  plan(23)

  // lookup
  same(partitions.lookup({ key: 'foo' }), 'foo', 'lookup on object')
  same(partitions.lookup(peers.serialise({ key: 'foo', type: 'update' })), 'foo', 'lookup on buffer')

  // append
  partitions.append({ type: 'update', key: 'foo', value: 1 })
  same(partitions.foo, [ 
      { type: 'update', key: 'foo', value: 1, ptime: 1 }
    ]
  , 'append new changes'
  )

  partitions.append({ type: 'update', key: 'foo', value: 2, ptime: 2 })
  same(partitions.foo, [ 
      { type: 'update', key: 'foo', value: 1, ptime: 1 }
    , { type: 'update', key: 'foo', value: 2, ptime: 2 }
    ]
  , 'append in-order commit'
  )

  partitions.append(
    { type: 'update', key: 'foo', value: 2, ptime: 10 }
  , { nack: (p, head) => same([p , head], ['foo', 3], 'nack out-of-order commit') }
  )
  same(partitions.foo.length, 2, 'append nack future commit')

  partitions.append({ type: 'update', key: 'foo', value: 1, ptime: 1 })
  same(partitions.foo.length, 2, 'reject historic commit')

  // change
  partitions.change(peers.serialise({ type: 'irregular', key: 'foo', value: 3, ptime: 3 }))
  same(partitions.foo.length, 2, 'reject irregular change - partitions')
  same(peers.cache, {}, 'reject irregular change - cache')
  
  partitions.change(peers.serialise({ type: 'update', key: 'foo', value: 3, ptime: 3 }))
  same(partitions.foo.length, 3, 'change - partitions')
  same(peers.cache, { foo: 3 }, 'change - cache')

  // commit
  peers.cache.emit('change', peers.deserialise(peers.serialise({ type: 'update', key: 'foo', value: 4, ptime: 4 })))
  same(broadcast.length, 0, 'commit - do not proxy commit received on client')

  peers.cache.emit('change', { type: 'update', key: 'foo', value: 4, ptime: 4 })
  same(broadcast.length, 1, 'commit - proxy new on client')
  same(broadcast[0], {
    change: peers.serialise({ type: 'update', key: 'foo', value: 4, ptime: 4 })
  , command: peers.constants.commands.proxy
  }, 'commit - proxy new commit on client')

  peers.me = true
  peers.cache.emit('change', { type: 'update', key: 'foo', value: 5 })
  same(partitions.foo.length, 4, 'commit - append new on server')
  same(broadcast.length, 2, 'commit - append new on server')
  same(broadcast[1], {
    change: peers.serialise({ type: 'update', key: 'foo', value: 5, ptime: 4 })
  , command: peers.constants.commands.commit
  }, 'commit - append new on server')

  let changeFromProxy = peers.deserialise(peers.serialise({ type: 'update', key: 'foo', value: 6 }))
  changeFromProxy.buffer.command = peers.constants.commands.proxy
  peers.cache.emit('change', changeFromProxy)
  same(partitions.foo.length, 4, 'commit - propagate directly handle commit')
  same(broadcast.length, 3, 'commit - propagate directly handle commit')
  same(broadcast[2], {
    change: peers.serialise({ type: 'update', key: 'foo', value: 6, ptime: 0 })
  , command: peers.constants.commands.commit
  }, 'commit - propagate directly handle commit')

  let changeFromCommit = peers.deserialise(peers.serialise({ type: 'update', key: 'foo', value: 7 }))
  changeFromCommit.buffer.command = peers.constants.commands.commit
  peers.cache.emit('change', changeFromCommit)
  same(partitions.foo.length, 4, 'commit - propagate commit from peer to own clients')
  same(multicast.length, 1, 'commit - propagate commit from peer to own clients')
  same(multicast[0], {
    change: peers.serialise({ type: 'update', key: 'foo', value: 7, ptime: 0 })
  , command: peers.constants.commands.commit
  }, 'commit - propagate commit from peer to own clients')

}()