module.exports = Peers

function Peers({ name = '*', tracer, server, client, udp, hosts, ports, hash, cache, from, constants = {}} = {}){
  // console.log("*********************")

  def(this, 'name'        , name)
  def(this, 'tracer'      , tracer)
  def(this, 'me'          , server)
  def(this, 'cache'       , cache)
  def(this, 'pool'        , debounce(50)(pool))
  // def(this, 'flush'        , debounce(10)(flush))
  def(this, 'constants'   , new Constants(constants))
  def(this, 'dht'         , new DHT(this, hash))
  def(this, 'retries'     , new Retries(this.constants.retries))
  def(this, 'connections' , this.constants.connections.max[server ? 'server' : 'client'])
  def(this, 'lists'       , { disconnected: [], connected: [], connecting: [], throttled: [], client: [], dirtyin: [], dirtyout: [], all: [] })
  def(this, 'sindex'      , 0, 1)
  // def(this, 'timeouts'    , { flush: setInterval(this.flush.bind(this)) })
  def(this, 'timeouts'    , { })
  def(this, 'discover'    , {
    tcp: require('./discovertcp')(this, hosts, ports)
  , udp: require('./discoverudp')(this, name, udp)
  })
  // this.dirtymap = {}

  // this.timeouts.sth = setInterval(d => {
  //   console.log("process._getActiveHandles().length", process._getActiveHandles().length)
  //   for (peer of this)
  //     console.log("i", +!!this.me, peer.id, peer.hw.outbox)
  // }, 3000)
  if (from)
    define(this, 'from', { value: from })

  if (server) 
    server.raw.on('connection', this.join.bind(this))

  cache
    // TODO (perf): test if using consts is faster
    .on('proxy' , this.proxy.bind(this))
    // .on('nack'  , this.nack.bind(this))
    .on('init', init.bind(this))
    .on('sync', sync.bind(this))
    .on('done', done.bind(this))

  cache
    // .on('connected', peer => { peer.retry = 0 })
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

Peers.prototype.dirtyin = function(peer){
  if (!peer.dirtyin) {
    peer.dirtyin = this.lists.dirtyin.push(peer)
    if (!this.timeouts.flushin) 
      this.timeouts.flushin = setTimeout(d => {
        this.timeouts.flushin = 0
        while (d = this.lists.dirtyin.pop()) d.flushin()
      })
  }
}

Peers.prototype.dirtyout = function(peer){
  if (!peer.dirtyout) {
    peer.dirtyout = this.lists.dirtyout.push(peer)
    if (!this.timeouts.flushout) 
      this.timeouts.flushout = setTimeout(d => {
        this.timeouts.flushout = 0
        while (d = this.lists.dirtyout.pop()) d.flushout()
      })
  }
}

// Peers.prototype.flush = function(d){
//   // let p, i = 0 
//   // while (p = this.lists.all[i])
//   // for (let i = 0; i < this.lists.all.length; i++) {
//   //   // console.log("this.lists.all[i]", this.lists.all[i])
//   //   this.lists.all[i].flush()
//   // }
//   // let peer
//   // var p
//   // while(p = this.lists.dirty.pop())
//   //   p.flush()
//   // d => {
//   while (d = this.lists.dirty.pop()) d.flush()
//   this.timeouts.flush = 0
//   // })
//   // for (let i = 0; i < this.lists.dirty.length; i++)
//   //   this.lists.dirty[i].flush()
//   // this.dirtymap = {}
// }
Peers.prototype.flush = function(){
  // let all = [].concat(this.lists.connected, this.lists.disconnected, this.lists.connecting, this.lists.client)
// console.log("this.lists.all", this.lists.all)
  for (let i = 0, peer; peer = this.lists.all[i]; i++) {
    // if (all[i].hw.yacks !== all[i].lw.yacks) {
    //   this.boxes.yack.writeUInt32BE(all[i].lw.yacks = all[i].hw.yacks, 6)
    //   all[i].socket.write(this.boxes.yack)
    //   // all[i]socket.write('' + (all[i].lw.yacks = all[i].hw.yacks), all[i].peers.constants.commands.yack)
    // }
    if (peer.hw.outbox && peer.socket && !peer.socket.destroyed) {
      peer.socket.write(Buffer.from(peer.outbox.slice(0, peer.hw.outbox)))
      peer.hw.outbox = 0
      this.cache.emit('tack', { value: peer.tacks, peer: peer })
    }

    for (let j = 0; j < peer.inbox.length; j++) {
      // deb('recv', this.constants.commands[peer.inbox[j].command]/*, peer.inbox[j]*/, peer.uuid.bgRed)
      // emit(this.cache.on[this.constants.commands[peer.inbox[j].command]], peer.inbox[j])
      this.cache.emit(this.constants.commands[peer.inbox[j].command], peer.inbox[j])
    }
    peer.inbox = []

  }
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
    // if (!this.me) console.log("client send", ++x, this.sindex, this.lists.connected[(this.sindex+1) % this.lists.connected.length].port)
    return this.lists.connected[this.sindex = (this.sindex+1) % this.lists.connected.length].send(message, this.constants.commands.proxy)
  else
    deb('sending with no-one connected', this.name)
}

Peers.prototype.owner = function(change) {
  // TODO: mark cached owner by generation
  // console.log("change", change, this.cache.partitions.lookup(change))
  change.owner = this.dht.lookup(this.cache.partitions.lookup(change))
  // console.log("change.owner", change.owner)
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

// in-memory alternative to proxying a send, with same sig
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
  console.log("next", change.json())
  return change.peer.server && Peers.prototype.from.call(this, change)
}


// Peers.prototype.wait = function(peer){
//   // console.log("peer", peer.tacks)
//   return new Promise(resolve => peer.replies[peer.tacks] = resolve)
// }

// Peers.prototype.reply = function(message) {
//   // const tack = 
//   console.log("message", message)
// console.log("message.buffer", message.buffer)  
//   this.cache.emit('reply', { tack: message.buffer.readUInt32LE(), message })
//   // if (tack in peer.replies) {

//   //   peer.replies[tack](buffer.slice(4))
//   //   delete peer.replies[tack]
//   // }
//   // else {
//   //   deb('missing reply handler', peer.id, tack, peer.tacks, keys(peer.replies).length, peer.missing = (peer.missing || 0) + 1)
//   // }
// }

// Peers.prototype.nack = function(buffer) {
//   const [id, head] = buffer.toString().split(' ')
//       , partition = this.partitions[id] || this.partitions.create(id)
//       , index = partition.findIndex(({ ptime }) => ptime == head) // TODO substract ptimes
  
//   if (~index) {
//     const commits = partition.slice(index)
//     deb('nack hit'.green, index, buffer.peer.id, id, head, '→', last(partition).ptime, `(${commits.length})`)
//     commits.map(c => buffer.peer.send(c.buffer || this.serialise(c), this.constants.commands.commit))
//   } else {
//     deb('nack miss'.red, buffer.peer.id, id, head, '→', last(partition).ptime, `(${partition.length})`)
//     buffer.peer.send(keys(partitions.keys)(this.cache), this.constants.commands.rewind)
//   }
// }

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