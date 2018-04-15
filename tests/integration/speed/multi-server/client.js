const { emitterify } = require('utilise/pure')
    , generate  = require('../../../utils/generate-messages')
    , argv      = require('minimist')(process.argv.slice(2))
    , Change    = require('fero/messages/change')
    , padstart  = require('lodash.padstart')
    , records   = +argv.r || 1000000
    , msize     = +argv.m || 100
    , index     = +argv.i || 1

require('fero')('speed-test', { client: true }).then(async cache => {
  // const messages = generate(records, msize)
  const { buffer } = new Change('update', index, padstart('*', msize - 4))
  
  const sacks = cache
    .on('reply')
    .reduce(acc => ++acc, 0)
    .filter(acc => acc === records)
    .then(d => process.hrtime(start))

  const yacks = cache
    .on('ack')
    .reduce((acc, m) => (acc += (-(m.peer.yacks || 0) + (m.peer.yacks = ~~m.value))), 0)
    .filter(total => total == records)
    .map(d => process.hrtime(start))

  if (!cache.run)
    await cache.on('change').filter(() => cache.run)

  const start = process.hrtime()

  for (var i = 0; i < records; i++)
    cache.peers.send(buffer)

  require('./stat')({ msize, records }, await Promise.all([yacks, sacks]))
})