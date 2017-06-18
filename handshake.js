module.exports = { connect, init, sync, done }

// L
function connect(){
  const { host, port } = this
  
  delete this.timeouts.retry
  if (this.status == 'connecting')
    return deb('abandon - already connecting', this.id.grey, this.uuid.bgRed)
  if (this.status != 'disconnected' && this.status != 'throttled')
    return deb('abandon - unexpected status', this.status, this.id.grey, this.uuid.bgRed)

  this.setStatus('connecting')
  
  if (this.socket) {
    deb('(L) connect', `${this.socket.localAddress}:${this.socket.localPort} → ${this.socket.remoteAddress}:${this.socket.remotePort}`.grey, this.uuid.bgRed)  
    const delay  = jit(1)(this.peers.constants.connections.jitter*(1 + this.peers.lists.disconnected.length + this.peers.lists.connecting.length))
    this.timeouts.connect = time(delay, d => {
      if (this.status != 'connecting') 
        return deb('abandon - not connecting', this.id.grey, this.uuid.bgRed) 
      if (this.socket.attempted) 
        return deb('abandon - connect attempted', this.id.grey, this.uuid.bgRed)  
      
      this.timeouts.connection = time(this.peers.constants.connections.timeout, d => {
        if (this.status == 'connecting') {
          deb('connection timeout'.red, this.id.grey, this.uuid.bgRed)
          this.fail()
        }
      })

      this.socket.attempted = true
      this.send({
        laddress: this.peers.me ? this.peers.me.address : 'client'
      , lpeers: this.peers.lists.connected.map(d => d.id)
      , lpartitions: this.peers.me ? this.peers.cache.partitions.heads() : {}
      , lid: this.peers.me ? this.peers.me.id : ''
      }, this.peers.constants.commands.init) 
    })

  }
  else
    this.socket = net.connect(port, host, this.connect.bind(this))
}

// R
function init(message) {
  const { peer } = message
  peer.socket.attempted = true

  const { laddress, lpeers, lpartitions, lid } = message.json()
      , rpartitions = peer.peers.me ? peer.peers.cache.partitions.heads() : {}
      , rpeers = peer.peers.lists.connected.map(d => d.id)
      , raddress = peer.peers.me ? peer.peers.me.address : 'client'
      , dirpartitions = canFastForwardPartitions(lpartitions, rpartitions, laddress, raddress)
      , dirpeers = true // TODO: canFastForwardPeers(lpeers, rpeers)

  if (is.in(rpeers)(lid))
    return deb('abandon - connected init', rid.grey, peer.uuid.bgRed) 

  // deb('init rneed diff', rneed.length, peer.uuid.bgRed)
  // deb('(R) init', dirpartitions, dirpeers, `${peer.peers.me.address} ← ${peer.socket.remoteAddress}:${peer.socket.remotePort}`.grey, peer.uuid.bgRed)

  if (!dirpartitions || !dirpeers || (is.str(dirpartitions) && is.str(dirpeers) && dirpartitions !== dirpeers)) {
    return deb('cannot fast forward ..?', dirpartitions, dirpeers, '\n', lpeers, '\n', rpeers)
  } else if (dirpartitions == 'L → R') {
    deb('(R) init L → R', rpartitions, peer.uuid.bgRed)
    peer.send({ raddress, rpartitions }, peer.peers.constants.commands.sync)
  } else {//if (dirpartitions == 'R → L') {
    const rdiff = peer.peers.cache.partitions.diff(lpartitions)
    deb('(R) init R → L', rdiff.length, peer.uuid.bgRed)
    peer.send({ raddress, rpeers, rdiff }, peer.peers.constants.commands.sync) // TODO: JSON is wasteful here, we have the buffers
    
    if (laddress === 'client') {
      peer.setStatus('client')
      peer.client = true
    } else { 
      peer.setStatus('connected', laddress)
      peer.server = true
    }
  }
}

// L
function sync(message) {
  const { peer } = message

  let { raddress, rpartitions, rpeers, rdiff } = message.json()
    , laddress = peer.peers.me ? peer.peers.me.address : 'client'

  if (rdiff) {
    deb('(L) sync R → L', rdiff.length, peer.uuid.bgRed)

    if (!peer.peers.me) peer.peers.cache.reset()
    rdiff.map(change => peer.peers.cache.partitions.append(extend(new Change(change))({ replay: true })))
    rpeers
      .filter(not(isConnected(peer.peers)))
      .map(dot)
      .map(split(':'))
      .map(([host, port]) => peer.peers.create(host, port, undefined, true))
  } else {
    const ldiff = peer.peers.cache.partitions.diff(rpartitions)
        , lpeers = peer.peers.lists.connected.map(d => d.id)
    deb('(L) sync L → R', ldiff.length, peer.uuid.bgRed)
// console.log("str(ldiff)", str({ laddress, ldiff, lpeers }).length)
    peer.send({ laddress, ldiff, lpeers }, peer.peers.constants.commands.done)
  }

  if (raddress === 'client') {
    peer.setStatus('client')
    peer.client = true
  } else { 
    peer.setStatus('connected', raddress)
    peer.server = true
  }
}

// R
function done(message) {
  // console.log("done", message.buffer.length, message.buffer.toString().length, message.text().length)
  const { peer } = message
      , { laddress, ldiff, lpeers } = message.json()
  
  if (ldiff) {
    deb('(R) done L → R', ldiff.length, peer.uuid.bgRed)
    if (!peer.peers.me) peer.peers.cache.reset()
    ldiff
      .map(change => peer.peers.cache.partitions.append(extend(new Change(change))({ replay: true })))
    lpeers
      .filter(not(isConnected(peer.peers)))
      .map(dot)
      .map(split(':'))
      .map(([host, port]) => peer.peers.create(host, port, undefined, true))
  } else {
    deb('(R) done R → L', peer.uuid.bgRed)    
  }

  if (laddress === 'client') {
    peer.setStatus('client')
    peer.client = true
  } else { 
    peer.setStatus('connected', laddress)
    peer.server = true
  }
}

const net = require('net')
    , deb = require('./deb')('han'.bgWhite.black.bold)

const isConnected = peers => id => id in peers && (peers[id].status === 'connected')
    , { key, keys, not, is, time, split, str, parse, flatten, extend } = require('utilise/pure')
    , { jit } = require('./utils')
    , dot = str => str.replace(/-/g, '.')
    , Change = require('./messages/change')

// function canFastForward(lpartitions, lpeers, rpartitions, rpeers) {
//   const partitions = canFastForwardPartitions(lpartitions, rpartitions) 
//       , peers = canFastForwardPeers(lpeers, rpeers) 

//   return !partitions || !peers                 ? false
//        : partitions === true && peers === true ? true
//        : partitions === peers                  ? partitions
//                                                : false
// }

// TODO: Allow bidirectional conflict-free merges
const canFastForwardPartitions = (lpartitions, rpartitions, laddress, raddress) => 
  laddress == 'client'                                                                             ? 'R → L'
: raddress == 'client'                                                                             ? 'L → R'
: str(lpartitions) == str(rpartitions)                                                             ? true
: keys(rpartitions).every(id => id in lpartitions && lpartitions[id].head >= rpartitions[id].head) ? 'L → R'
: keys(lpartitions).every(id => id in rpartitions && rpartitions[id].head >= lpartitions[id].head) ? 'R → L'
                                                                                                   : false

function canFastForwardPeers(lpeers, rpeers) {
  // console.log("canpff", lpeers, rpeers)
  return  lpeers.every(is.in(rpeers)) && rpeers.every(is.in(lpeers)) ? true
       : !lpeers.every(is.in(rpeers)) && rpeers.every(is.in(lpeers)) ? 'L → R'
       : !rpeers.every(is.in(lpeers)) && lpeers.every(is.in(rpeers)) ? 'R → L'
                                                                     : false
}