const connect = storage => async cache => {
  cache = await cache
  if (!(cache instanceof Cache)) {
    return (await Promise.all(values(cache).map(connect(storage))))
      .reduce(to.obj(cache => cache.peers.name), {})
  }

  cache.peers.ready = false
  if (!cache.peers.me) { throw new Error('cannot connect client to storage') }

  await restore(cache, storage)
  await replay(cache, storage)

  cache.peers.ready = true
  return cache
}

// restore from storage if first mover
const restore = async (cache, storage) => {
  cache.timeouts.restore = delay(cache.peers.constants.connect.wait)
  await Promise.race([cache.timeouts.restore, cache.on('connected.init')])
  cache.timeouts.restore.abort()
      
  if (!cache.peers.lists.connected.length && !keys(cache).length) {
    await storage.restore(cache)
    deb(`restored ${str(keys(cache).length)} records`.green)
  } else {
    deb(`abandon restore`.yellow)
  }
}

// replays actions from the service onto the respective storage
const replay = (cache, storage) => {
  cache
    .on('change')
    .filter(change => change.owner == cache.peers.me)
    .map(change => change.type in storage 
      ? storage[change.type](cache, change)
      : deb(`change "${type}" not handled by storage (${cache.peers.name})`)
    )
}

module.exports = connect

const { is, values, to, delay, keys, str } = require('utilise/pure')
    , Cache = require('./cache')
    , deb = require('./deb')('con'.bgBlue.bold)