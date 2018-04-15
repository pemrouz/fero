module.exports = Constants
  
function Constants(params = {}){
  const { constants = {} } = require('minimist')(process.argv)
  merge(this, defaults, constants, params) // TODO should merge top level one by one
}

const { pow } = Math
    , merge = require('lodash.merge')
    , defaults = {
        dht: {
          vnodes: 200
        }

      , connect: {
          wait: 3000
        }

      , retries: {
          base  : 100
        , max   : 5
        , cap   : 60000
        , jitter: 0.5
        }

      , connections: {
          timeout: 10000
        , jitter: 200
        , max: {
            server: Infinity
          , client: 1
          }
        }

      , multicast: {
          type: 'udp'
        , ip: '224.0.0.251'
        , host: '127.0.0.1'
        , port: 3130
        , ttl: 128
        , jitter: 2000
        , retry: false
        , monitor: true
        }

      , types: {
          0x1: 'string'
        , 0x2: 'number'
        , 0x3: 'json'
        , 0x4: 'boolean'
        , 0x5: 'undefined'
        , 'string'   : 0x1
        , 'number'   : 0x2
        , 'json'     : 0x3
        , 'boolean'  : 0x4
        , 'undefined': 0x5
        }

      , change: {
          0x1: 'update'
        , 0x2: 'remove'
        , 0x3: 'add'
        , 0x4: 'subscribe'
        , 0x5: 'stop'
        , 'update'     : 0x1
        , 'remove'     : 0x2
        , 'add'        : 0x3
        , 'subscribe'  : 0x4
        , 'stop'       : 0x5
        }

      , commands: {
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

      , partitions: {
          history: {
            max: Infinity
          }
        }

      , hosts: ['127.0.0.1']

      , ports: []

      , outbox: {
          max: pow(2, 16)
        , frag: pow(2, 16)
        }
    }