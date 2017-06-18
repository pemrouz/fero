module.exports = DHT

function DHT(peers, hash = djb){
  this.ring   = emitterify(new RBTree((a, b) => (a.hash - b.hash)))
  this.vnodes = {}
  this.hash   = hash
  this.peers  = peers

  peers.cache
    .on('status', (status, peer) => status == 'connected'
        ? this.insert(peer)
        : this.remove(peer)
    )

  if (peers.me) 
    this.insert(peers.me)
}

DHT.prototype.lookup = function(key){
  // console.log("key", key)
  // TODO: always have a peer?
  return /*typeof key !== 'undefined' &&*/ (this.ring.lowerBound({ hash: this.hash(key || '') }).next() || this.ring.min() || {}).peer
}

DHT.prototype.insert = function(peer){
  if (peer.id in this.vnodes) return

  this.vnodes[peer.id] = []
  this.vnodes[peer.id].peer = peer
  for (let i = 0, hash; i < this.peers.constants.vnodes; i++) {
    this.vnodes[peer.id].push(hash = this.hash(peer.id + '*' + i))
    this.ring.insert({ peer, hash })
  }

  this.checksum = checksum(this.vnodes, this.hash)
  this.peers.cache.emit('checksum', this.checksum)
  deb('insert', peer.id, this.ring.size/this.peers.constants.vnodes, this.checksum, peer.uuid.bgRed)
}

DHT.prototype.remove = function(peer) {
  const vnodes = this.vnodes[peer.id]
  if (!vnodes || vnodes.peer !== peer) return

  for (let i = 0; i < vnodes.length; i++)
    this.ring.remove({ hash: vnodes[i] })

  delete this.vnodes[peer.id]
  this.checksum = checksum(this.vnodes, this.hash)
  this.peers.cache.emit('checksum', this.checksum)
  deb('remove', peer.id, this.ring.size/this.peers.constants.vnodes, this.checksum, peer.uuid.bgRed)
}

const checksum = (vnodes, hash) => hash(keys(vnodes).sort().join(';'))

const djb = str => {
  let hash = 5381
    , i = str.length

  while (i)
    hash = (hash * 33) ^ str.charCodeAt(--i)

  return hash >>> 0
}

const { RBTree } = require('bintrees')
    , { emitterify, keys } = require('utilise/pure')
    , deb = require('./deb')('rin'.bgBlue.bold)