const argv   = require('minimist')(process.argv.slice(2))
    , fero   = require('fero')
    , csize  = argv.c || 1

fero('speed-test', () => 'ack').then(async cache => {

  await cache
    .on('status')
    .map(d => console.log("status", cache.peers.lists))
    .filter(() => cache.peers.lists.client.length == csize)

  cache.update('run', true)
})