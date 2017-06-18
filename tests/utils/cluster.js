const spawn     = require('./spawn')('peer')
    , log       = require('utilise/log')('[fero/benchmark/cluster]')
    , checksums = require('./checksums')
    , { combine } = require('../../utils')
    , { by } = require('utilise/pure')

module.exports = async ({ csize, test }) => stable(Array(csize).fill().map(spawn(test, { c: csize, l: lsize, m: msize })))

async function stable(peers) {
  const changes = combine(peers, 'checksum')
      , start = process.hrtime()

  // log if peer yet to still discover all other peers
  changes
    .filter(({ checksum }) => checksum != checksums[peers.length])
    .map(({ checksum }) => log('cluster unstable'.red, checksums[peers.length], '/', checksum))
    
  // log and record time it took peer to discover all other peers
  // resolve when all peers discovered all other peers
  return changes
    .filter(({ checksum }) => checksum === checksums[peers.length])
    .filter(({ parent, checksum }) => (parent.results.stable = process.hrtime(start)))
    .map(({ checksum }) => log('cluster peer stable'.yellow, checksum))
    .filter(d => peers.every(by('results.stable')))
    .map(d => log('cluster stable'.green, '(', peers.length, ')'))
    .map(d => peers)
}