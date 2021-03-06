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
        laddress: this.peers.me ? this.peers.me.address : `client ${this.peers.group}`
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

  const { laddress, lpeers, lpartitions, lid } = message.value
      , rpartitions = peer.peers.me ? peer.peers.cache.partitions.heads() : {}
      , rpeers = peer.peers.lists.connected.map(d => d.id)
      , raddress = peer.peers.me ? peer.peers.me.address : `client ${peer.peers.group}`
      , dirpartitions = canFastForwardPartitions(lpartitions, rpartitions, laddress, raddress)
      , dirpeers = true // TODO: canFastForwardPeers(lpeers, rpeers)

  if (is.in(rpeers)(lid))
    return deb('abandon - connected init', rid.grey, peer.uuid.bgRed) 

  if (laddress.startsWith('client') && !peer.peers.ready) 
    return deb('server (R) not ready'), peer.socket.destroy()

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
    
    if (laddress.startsWith('client')) {
      peer.setStatus('client')
      peer.client = laddress.slice(7) || true
    } else { 
      peer.setStatus('connected', laddress)
      peer.server = true
    }
  }
}

// L
function sync(message) {
  const { peer } = message

  let { raddress, rpartitions, rpeers, rdiff } = message.value
    , laddress = peer.peers.me ? peer.peers.me.address : `client ${peer.peers.group}`

  if (raddress.startsWith('client') && !peer.peers.ready) 
    return deb('server (L) not ready'), peer.socket.destroy()

  if (rdiff) {
    deb('(L) sync R → L', rdiff.length, peer.uuid.bgRed)

    if (!peer.peers.me) peer.peers.cache.reset()
    rdiff.map(change => peer.peers.cache.partitions.append(createChange(change)))
    rpeers
      .filter(not(isConnected(peer.peers)))
      .map(dot)
      .map(split(':'))
      .map(([host, port]) => peer.peers.create(host, port, undefined, true))
  } else {
    const ldiff = peer.peers.cache.partitions.diff(rpartitions)
        , lpeers = peer.peers.lists.connected.map(d => d.id)
    deb('(L) sync L → R', ldiff.length, peer.uuid.bgRed)
    peer.send({ laddress, ldiff, lpeers }, peer.peers.constants.commands.done)
  }

  if (raddress.startsWith('client')) {
    peer.setStatus('client')
    peer.client = raddress.slice(7) || true
  } else { 
    peer.setStatus('connected', raddress)
    peer.server = true
  }
}

// R
function done(message) {
  const { peer } = message
      , { laddress, ldiff, lpeers } = message.value
  
  if (ldiff) {
    deb('(R) done L → R', ldiff.length, peer.uuid.bgRed)
    if (!peer.peers.me) peer.peers.cache.reset()
    ldiff
      .map(change => peer.peers.cache.partitions.append(createChange(change)))
    lpeers
      .filter(not(isConnected(peer.peers)))
      .map(dot)
      .map(split(':'))
      .map(([host, port]) => peer.peers.create(host, port, undefined, true))
  } else {
    deb('(R) done R → L', peer.uuid.bgRed)    
  }

  if (laddress.startsWith('client')) {
    peer.setStatus('client')
    peer.client = laddress.slice(7) || true
  } else { 
    peer.setStatus('connected', laddress)
    peer.server = true
  }
}

const net = require('net')
    , deb = require('./deb')('han'.bgWhite.black.bold)
    , isConnected = peers => id => id in peers && (peers[id].status === 'connected')
    , { key, keys, not, is, time, split, str, parse, flatten, extend } = require('utilise/pure')
    , { jit } = require('./utils')
    , dot = str => str.replace(/-/g, '.')
    , Change = require('./messages/change')
    , createChange = ({ type, key, value }) => extend(new Change(type, key, value))({ replay: true })

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
  laddress.startsWith('client')                                                                    ? 'R → L'
: raddress.startsWith('client')                                                                    ? 'L → R'
: str(lpartitions) == str(rpartitions)                                                             ? true
: keys(rpartitions).every(id => id in lpartitions && lpartitions[id].head >= rpartitions[id].head) ? 'L → R'
: keys(lpartitions).every(id => id in rpartitions && rpartitions[id].head >= lpartitions[id].head) ? 'R → L'
                                                                                                   : false

function canFastForwardPeers(lpeers, rpeers) {
  return  lpeers.every(is.in(rpeers)) && rpeers.every(is.in(lpeers)) ? true
       : !lpeers.every(is.in(rpeers)) && rpeers.every(is.in(lpeers)) ? 'L → R'
       : !rpeers.every(is.in(lpeers)) && lpeers.every(is.in(rpeers)) ? 'R → L'
                                                                     : false
}