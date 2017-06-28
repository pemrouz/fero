module.exports = Peers

function Peers({ name = '*', tracer, server, client, udp, hosts, ports, hash, cache, from, constants = {}} = {}){
  def(this, 'name'        , name)
  def(this, 'tracer'      , tracer)
  def(this, 'me'          , server)
  def(this, 'cache'       , cache)
  def(this, 'pool'        , debounce(50)(pool))
  def(this, 'constants'   , new Constants(constants))
  def(this, 'dht'         , new DHT(this, hash))
  def(this, 'retries'     , new Retries(this.constants.retries))
  def(this, 'connections' , this.constants.connections.max[server ? 'server' : 'client'])
  def(this, 'lists'       , { disconnected: [], connected: [], connecting: [], throttled: [], client: [], all: [] })
  def(this, 'sindex'      , 0, 1)
  def(this, 'timeouts'    , { })
  def(this, 'discover'    , {
    tcp: require('./discovertcp')(this, hosts, ports)
  , udp: require('./discoverudp')(this, name, udp)
  })
  
  if (from)
    define(this, 'from', { value: from })

  if (server) 
    server.raw.on('connection', this.join.bind(this))

  cache
    // TODO (perf): test if using consts is faster
    .on('proxy' , this.proxy.bind(this))
    .on('init', init.bind(this))
    .on('sync', sync.bind(this))
    .on('done', done.bind(this))

  cache
    .on('status', (status, peer) => {
      const text = status == 'disconnected' ? status.cyan
                 : status == 'connecting'   ? status.yellow
                 : status == 'connected'    ? status.green
                 : status == 'removed'      ? status.red
                 : status == 'client'       ? status.green
                 : status

      deb(text, peer.id.grey, name, peer.uuid.bgRed)
      cache.emit(status, peer)
      this.pool()
    })
}

const { def, emitterify, debounce, remove, keys, values, is } = require('utilise/pure')
    , { emit, last, formatID } = require('./utils')
    , { init, sync, done } = require('./handshake')
    , Partitions = require('./partitions')
    , Constants = require('./constants')
    , Retries = require('./retries')
    , DHT = require('./dht')
    , define = Object.defineProperty

Peers.prototype.create = function(host, port, socket, server) {
  const id = formatID(`${host}:${port}`)
      , peer = id in this                   ? !deb('duplicate peer', id)
             : this.me && id === this.me.id ? !deb('duplicate self', id)
             : new Peer(this, host, port, socket, server)
}

Peers.prototype.remove = function(peer) {
  return new Promise(resolve => {
    if (is.str(peer))
      peer = this[peer]

    if (this[peer.id] != peer) // TODO: This should never happen
      return deb('mismatch - already removed'.red, peer.id, peer.uuid, peer/*.bgRed*/) 
    
    deb('removing', peer.id, peer.uuid.bgRed)

    for (let timeout in peer.timeouts) {
      clearTimeout(peer.timeouts[timeout])
      delete peer.timeouts[timeout]
    }

    if (peer.socket && !peer.socket.destroyed) {
      deb('closing socket'.red, peer.uuid.bgRed)
      peer.socket.removeAllListeners()
      peer.socket.destroy() // TODO: should destroy gracefully
    }

    remove(peer.id)(this)
    peer.setStatus('removed')
    resolve() // TODO: should remove gracefully from cluster
  })
}

process.on('uncaughtException', e => console.log("uncaught", e))

Peers.prototype.multicast = function(buffer, command, audience = 'client', results = []) {
  for (let i = 0; i < this.lists[audience].length; i++)
    results.push(this.lists[audience][i].send(buffer, command))
  return results
}

Peers.prototype.broadcast = function(buffer, command, results = []){
  if (buffer === false) return false
  this.multicast(buffer, command, 'connected', results)
  this.multicast(buffer, command, 'client', results)
  return results
}

Peers.prototype.anycast = Peers.prototype.send = function(message) {
  if (this.lists.connected.length)
    return this.lists.connected[this.sindex = (this.sindex+1) % this.lists.connected.length].send(message, this.constants.commands.proxy)
  else
    deb('sending with no-one connected', this.name)
}

Peers.prototype.owner = function(change) {
  // TODO: mark cached owner by generation
  change.owner = this.dht.lookup(this.cache.partitions.lookup(change))
  return change.owner
}

Peers.prototype.join = function(socket) {
  this.create(socket.remoteAddress, socket.remotePort, socket)
}

Peers.prototype.proxy = function(message){
  const owner = this.owner(message)
  if (!owner || owner === this.me) {
    const reply = this.from(message, this.cache)
    // TODO: perf this
    return !is.def(reply)     ? false
         :  is.promise(reply) ? reply.then(reply => is.def(reply) && message.reply(reply))
                              : message.reply(reply)
  } else if (owner) {
    owner.send(message.buffer, this.constants.commands.proxy).on('reply', reply => message.reply(reply))
    // if (this.tracer)
    //   update(`${this.me.port}-${owner.port}-${owner.tacks}.pid`, `${buffer.peer.client ? 'client' : buffer.peer.port}-${this.me.port}-${buffer.tack}`)(this.tracer)
  }
}

Peers.prototype.accept = function(change){
  const serialised = { json: () => change, peer: { server: !!this.me }}
      , result = this.from(serialised, this.cache)

  return { 
    on: async (d) => {
      const resolved = await result
      return { json: () => resolved } 
    }
  }
}

Peers.prototype.from = function(change){
  return this.broadcast(this.cache.partitions.append(change) && change.buffer, this.constants.commands.commit)
}

Peers.prototype.next = function(change){
  return change.peer.server && Peers.prototype.from.call(this, change)
}

Peers.prototype[Symbol.iterator] = function*(){
  for (id in this)
    if (this[id] instanceof Peer)
      yield this[id]
}

async function pool() {
  while (
    this.lists.disconnected.length && (
  + this.lists.connected.length
  + this.lists.connecting.length
  + this.lists.throttled.length
  ) < this.connections) {
    const peer = this
      .lists
      .disconnected
      .shift()

      if (peer) { 
        peer.connect()
        await this.cache.on('status').filter(([s, p]) => peer == p && s != 'connecting')
      }

   }
}

const deb = require('./deb')('per'.bgGreen.bold)
    , Peer = require('./peer')