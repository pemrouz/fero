module.exports = Peers

function Peers({ name = '*', tracer, server, client, udp, hosts, ports, hash, cache, from, constants = {}} = {}){
  def(this, 'name'        , name)
  def(this, 'tracer'      , tracer)
  def(this, 'me'          , server)
  def(this, 'cache'       , cache)
  def(this, 'group'       , is.str(client) ? client : '')
  def(this, 'pool'        , debounce(50)(pool))
  def(this, 'constants'   , new Constants(constants))
  def(this, 'dht'         , new DHT(this, hash))
  def(this, 'retries'     , new Retries(this.constants.retries))
  def(this, 'connections' , this.constants.connections.max[server ? 'server' : 'client'])
  def(this, 'lists'       , { disconnected: [], connected: [], connecting: [], throttled: [], client: [], all: [] })
  def(this, 'sindex'      , 0, 1)
  def(this, 'uuids'       , 0, 1)
  def(this, 'uuid'        , uuid())
  def(this, 'timeouts'    , { })
  def(this, 'ready'       , true, 1)
  def(this, 'destroyed'   , false, 1)
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
    .on('proxy', this.proxy.bind(this))
    .on('init' , init.bind(this))
    .on('sync' , sync.bind(this))
    .on('done' , done.bind(this))

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

Peers.prototype.create = function(host, port, socket, server) {
  const id = formatID(`${host}:${port}`)
      , peer = id in this                   ? !deb('duplicate peer', id)
             : this.me && id === this.me.id ? !deb('duplicate self', id)
             : new Peer(this, host, port, socket, server)
}

Peers.prototype.remove = function(peer) {
  return new Promise(async resolve => {
    if (is.str(peer))
      peer = this[peer]


    if (this[peer.id] != peer) // TODO: Confirm if this is still possible
      return deb('mismatch - already removed'.red, peer.id, peer.uuid, peer/*.bgRed*/) 
    
    for (let timeout in peer.timeouts) {
      clearTimeout(peer.timeouts[timeout])
      delete peer.timeouts[timeout]
    }

    if (peer.socket && !peer.socket.destroyed) {
      deb('closing socket'.red, peer.uuid.bgRed)
      peer.socket.removeAllListeners()
      peer.socket.destroy() // TODO: should destroy gracefully
    }

    peer.setStatus('removed')
    remove(peer.id)(this)
    resolve() // TODO: should remove gracefully from cluster
  })
}

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

Peers.prototype.join = function(socket) {
  this.create(socket.remoteAddress, socket.remotePort, socket)
}

Peers.prototype.owner = function(change) {
  // TODO: mark cached owner by generation
  if (change.owner) return change.owner

  if (change.type == 'stop') {
    if (change.peer.server) {
      delete change.value.owner
      delete change._buffer
    } 

    return change.owner = (change.value.owner 
      ? [...this].find(d => d.uuid == change.value.owner) 
      : this.me
      )
  }

  return change.owner = this.dht.lookup(this.cache.partitions.lookup(change))
}

Peers.prototype.proxy = function(message){
  const owner = this.owner(message)

  if (/*!owner || */owner === this.me) {
    if (message.type == 'stop') { 
      if (!(message.value.tack in message.peer.subscriptions))
        return console.error("no subscription", message.value)
      message.peer.subscriptions[message.value.tack].source.emit('stop')
      delete message.peer.subscriptions[message.value.tack]
      return message.reply('stopped')
    }

    const reply = this.from(message, this.cache)

    // TODO: perf this
    const finish = reply => 
      reply === false   ? false
   : !is.def(reply)     ? message.reply('sack')
   :  is.stream(reply)  ? (message.peer.subscriptions[message.tack] = reply.each(d => message.reply(d))).source.emit('start')
   :  is.promise(reply) ? reply.then(finish)
                        : message.reply(reply)

    return finish(reply)
  } else /*if (owner)*/ {
    if (!owner)  
      return console.error("no owner", message, owner)
    message.reply(new Change('subscribe', '', message.owner.uuid))
    owner
      .send(message.buffer, this.constants.commands.proxy)
      .on('reply')
      .each(reply => message.reply(reply.buffer))
    // if (this.tracer)
    //   update(`${this.me.port}-${owner.port}-${owner.tacks}.pid`, `${buffer.peer.client ? 'client' : buffer.peer.port}-${this.me.port}-${buffer.tack}`)(this.tracer)
  }
}

Peers.prototype.accept = function(change){
  const reply = emitterify().on('reply')
      , message = { 
          reply: value => reply.next({ value })
        , value: change
        , tack: ++this.me.tacks
        , owner: this.me
        , peer: this.me
        }
  
  reply
    .on('stop')
    .map(d => this.proxy({ 
      type: 'stop'
    , owner: this.me
    , peer: this.me
    , value: { tack: message.tack }
    , reply: d => d
    }))

  Promise
    .resolve()
    .then(d => this.proxy(message))

  return { on: d => reply }
}

Peers.prototype.from = function(change){
  // TODO: Should probably reuse this.cache.change, check perf impact
  if (!this.cache.partitions.append(change))
    return false

  // NOTE: This could be .replicate - broadcast and await replication factor before acking
  this.broadcast(change.buffer, this.constants.commands.commit)
  return change.value && change.value.id || true
}

Peers.prototype.next = function(change){
  return (change.peer.server || change.peer.client == 'monitor') && Peers.prototype.from.call(this, change)
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

const { def, emitterify, debounce, remove, keys, values, is, time } = require('utilise/pure')
    , { emit, last, formatID } = require('./utils')
    , { init, sync, done } = require('./handshake')
    , { Message, Change } = require('./messages')
    , Partitions = require('./partitions')
    , Constants = require('./constants')
    , Retries = require('./retries')
    , uuid = () => require('uuid/v4')()
    , Peer = require('./peer')
    , DHT = require('./dht')
    , deb = require('./deb')('per'.bgGreen.bold)
    , define = Object.defineProperty