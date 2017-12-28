module.exports = Cache

function Cache(opts){
  // TODO (perf): inline on prototype?
  emitterify(this)
  def(this, 'peers'     , new Peers(extend({ cache: this })(opts)))
  def(this, 'partitions', new Partitions(this))
  def(this, 'timeouts'  , {})
}

Cache.prototype.change = function(change) {
  // TODO: return same guarantees? replication?
  return !this.peers.me                              ? this.peers.send(change.buffer)
       :  this.peers.owner(change) !== this.peers.me ? change.owner.send(change.buffer)
       : (this.peers.broadcast(
            this.partitions.append(change) && change.buffer
          , this.peers.constants.commands.commit
          )
         , { on: () => ({ value: change.value.id || true }) })
}

Cache.prototype.update = function(k, v) {
  return this.change(new Change('update', k, v))
}

Cache.prototype.remove = function(k) {
  return this.change(new Change('remove', k))
}

Cache.prototype.push = function(k, v) {
  return this.change(new Change('add', `${k}.${key(k)(this).length}`, v))
}

Cache.prototype.set = function(t, k, v) {
  return this.change(new Change(t, k, v))
}

Cache.prototype.add = function(v, k) {
  return this.change(new Change('add', k || this.length, v))
}

Cache.prototype.patch = function(k, v) {
  return keys(v)
    .map(d => this.change(new Change('update', `${k}.${d}`, v[d])))
}

Cache.prototype.destroy = function(){
  return new Promise(async resolve => {
    if (this.peers.destroyed)
      return console.error('node has already been destroyed', this.peers.name, !!this.peers.me)
    
    this.peers.destroyed = true

    // clear timeouts
    for (let timeout in this.timeouts) {
      this.timeouts[timeout].abort
       ? this.timeouts[timeout].abort()
       : clearTimeout(this.timeouts[timeout])
      delete this.timeouts[timeout]
    }
    
    for (let timeout in this.peers.timeouts) {
      clearTimeout(this.peers.timeouts[timeout])
      delete this.peers.timeouts[timeout]
    }

    // close udp server
    if (this.peers.discover.udp) { 
      await Promise.all(this.peers.discover.udp.emit('stop'))
      await new Promise(resolve => this.peers.discover.udp.socket.close(resolve))
      
    }

    // remove peers
    for (let peer of this.peers)
      await this.peers.remove(peer)

    // close tcp server
    if (this.peers.me) {
      await new Promise(resolve => {
        this.peers.me.raw.unref()
        this.peers.me.raw.close(resolve)
      })
    }

    await Promise.all(this.emit('destroy'))

    resolve()
  })
}

Cache.prototype.reset = function(){
  deb('reset')
  keys(this).map(k => { delete this[k] })
  keys(this.partitions).map(k => { delete this.partitions[k] })
}

const { def, emitterify, extend, key, keys, str } = require('utilise/pure')
    , Partitions = require('./partitions')
    , Change = require('./messages/change')
    , Peers = require('./peers')
    , deb = require('./deb')('cac'.bgBlue.bold)