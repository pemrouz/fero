module.exports = Constants
  
function Constants(params = {}){
  const { constants = {} } = require('minimist')(process.argv)
  merge(this, constants, params) // TODO should merge top level one by one
}

const { pow } = Math
    , merge = require('lodash.merge')

Constants.prototype.dht = {
  vnodes: 200
}

Constants.prototype.restore = {
  wait: 1000
}

Constants.prototype.retries = {
  base  : 100
, max   : 5
, cap   : 60000
, jitter: 0.5
}

Constants.prototype.connections = {
  timeout: 10000
, jitter: 200
, max: {
    server: Infinity
  , client: 1
  }
}

Constants.prototype.udp = {
  skip: false
, jitter: 2000
, retry: false
}

Constants.prototype.types = {
  0x1: 'string'
, 0x2: 'number'
, 0x3: 'json'
, 0x4: 'undefined'
, 'string'   : 0x1
, 'number'   : 0x2
, 'json'     : 0x3
, 'undefined': 0x4
}

Constants.prototype.change = {
  0x1: 'update' 
, 0x2: 'remove'
, 0x3: 'add'
, 'update'  : 0x1
, 'remove'  : 0x2
, 'add'     : 0x3
}

Constants.prototype.commands = {
  init    : 1 << 0
, sync    : 1 << 1
, done    : 1 << 2
, proxy   : 1 << 3
, commit  : 1 << 4
, ack     : 1 << 5
, reply   : 1 << 6
, [1 << 0]: 'init'
, [1 << 1]: 'sync'
, [1 << 2]: 'done'
, [1 << 3]: 'proxy'
, [1 << 4]: 'commit'
, [1 << 5]: 'ack'
, [1 << 6]: 'reply'
}

Constants.prototype.partitions = {
  history: {
    max: Infinity
  }
}

Constants.prototype.outbox = {
  max: pow(2, 28)
, frag: pow(2, 16)
}