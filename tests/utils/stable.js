const log       = require('utilise/log')('[fero/benchmark/stabl]')
    , checksums = require('./checksums')

module.exports = peers => new Promise(resolve => {
  const start = process.hrtime()
  resolve = debounce(1000)(resolve)
  peers.map(peer => peer.on('message', ({ checksum }) => {
    if (checksum != checksums[peers.length]) return log("cluster unstable".red, checksums[peers.length], '/', checksum)
    peer.stable = process.hrtime(start)
    log("cluster peer stable".yellow, checksum)
    if (peers.every(by('stable'))) { 
      log('cluster stable'.green, '(', peers.length, ')')
      resolve(peers)
      peers.map(peer => peer.removeAllListeners())
    }
  }))
})
