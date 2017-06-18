const spawn = require('./spawn')('client')
    , log   = require('utilise/log')('[fero/benchmark/clients]')
    , { combine } = require('../../utils')
    , { by, extend } = require('utilise/pure')

const connected = async clients => combine(clients, 'connected')
  .filter(({ parent, connected }) => extend(parent.results)({ connected }))
  .filter(d => clients.every(by('results.connected')))
  .then(d => log('clients connected'.green, '(', clients.length, ')'))
  .then(d => clients)

module.exports = async ({ lsize, test }) => connected(Array(lsize).fill().map(spawn(test, { l: lsize, m: msize })))