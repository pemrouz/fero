module.exports = Partition

function Partition(partition, peers){
  this.length = 0
  this.partition = partition
  def(this, 'peers', peers, 1)
  def(this, 'head', undefined, 1)
  def(this, 'tail', undefined, 1)
  def(this, 'next', 1, 1)
}

Partition.prototype.slice = function(from){
  let sliced = [], next = this.head

  while (next && next.ptime != from) {
    sliced.unshift(next)
    next = next.prev
  }
  
  return sliced
}

Partition.prototype.append = function(change) {
  // console.log("append", change, key('peer.peers.name')(change), change && change.peer && change.peer.peers)
  if (change.ptime > this.next) 
    return deb('reject >', this.peers.me, this.partition, this.next, change.ptime), false

  if (change.ptime < this.next) 
    return deb('reject <', this.peers.me, this.partition, this.next, change.ptime), false

  if (!change.ptime) 
    change.ptime = this.next

  if (this.head)
    this.head.next = change

  if (!this.tail) 
    this.tail = change

  change.prev = this.head
  this.head = change
  this.next = (change.ptime + 1) % this.peers.constants.partitions.history.max
  this.length++
  // deb('applied', this.partition, this.head.ptime, this.length)

  while (this.length > this.peers.constants.partitions.history.max) {
    this.tail = this.tail.next
    this.tail.prev = this.tail
    this.length--
  }

  return change
}

const deb = require('./deb')('par'.bgRed.bold)
    , { last } = require('./utils')
    , { def, set, is, clone, to, keys, flatten, key } = require('utilise/pure')