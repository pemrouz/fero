module.exports = Partitions 

function Partitions(cache){
  def(this, 'cache', cache)

  cache
    .on('commit', change => this.append(change))
}

// get the latest offset of a particular partition
Partitions.prototype.head = function(id){
  return this[id] && this[id].head && this[id].head.ptime || 0
}

// get the partition a change belongs to
Partitions.prototype.lookup = function(change){
  return change.key && (change.key.split ? change.key.split('.')[0] : change.key || '')
}

// get offsets for all partitions, relative to base
Partitions.prototype.heads = function(){
  return keys(this)
    .sort()
    .map(id => ({ id, head: this.head(id) }))
    .reduce(to.obj, {})
}

// total number of partitions
Partitions.prototype.size = function(){
  return keys(this).length
}

// get change records relative to base
Partitions.prototype.diff = function(base){
  return keys(this)
    .filter(id => (!(id in base)) || this.head(id) > base[id].head)
    .map(id => this[id].slice(id in base ? base[id].head : 0))
    .reduce(flatten, [])
    .map(key(['type', 'key', 'value', 'ptime'])) // TODO proper serialise
}

Partitions.prototype.append = function(change, partition = this.lookup(change)){
  // create partition if doesn't exist
  if (!this[partition])
    this[partition] = new Partition(partition, this.cache.peers)

  // TODO: inline?
  if (!set(change, true)(this.cache))
    return false

  // append change 
  if (!this[partition].append(change))
    return false //deb('append failed', change)

  if (!change.replay)
    this.cache.emit('change', change)

  return true
}

const deb = require('./deb')('par'.bgRed.bold)
    , { last } = require('./utils')
    , { def, set, is, clone, to, keys, flatten, key, str } = require('utilise/pure')
    , Partition = require('./partition')