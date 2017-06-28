const { is, str, values, emitterify, by, key, keys, extend, delay } = require('utilise/pure')
    , { combine }   = require('../../../utils')
    , log           = require('utilise/log')('[fero/benchmark/speed]')
    , createClients = require('../../utils/clients')
    , createCluster = require('../../utils/cluster')
    , argv          = require('minimist')(process.argv)
    , records       = argv.r || 1000000
    , messages      = is.num(argv.m) ? [argv.m] : (argv.m || '100').split(',').map(Number)
    , clusters      = is.num(argv.c) ? [argv.c] : (argv.c || '1').split(',').map(Number)
    , clients       = is.num(argv.l) ? [argv.l] : (argv.l || '1').split(',').map(Number)
    , dump          = {} // TODO: capture machine info

log('records', str(records).green)
log('message', messages.join(', ').green, 'bytes')
log('cluster', clusters.join(', ').green, 'peers')
log('clients', clients.join(', ').green , 'clients')

const run = async (cluster, clients, details) => {
  clients.map(client => client.send('run'))

  await combine(clients, 'acks')
    .map(({ parent, acks }) => extend(parent.results)(acks))
    .filter(d => clients.every(by('results.tacks')))

  return require(`../${details.test}/stat`)(
    details
  , cluster.map(d => d.results)
  , clients.map(d => d.results)
  )
}

module.exports = async test => {
  for (msize of messages)
    for (csize of clusters)
      for (lsize of clients) {
        const details = { msize, csize, lsize, records, test }
            , cluster = await createCluster(details)
            , clients = await createClients(details)
            , results = await run(cluster, clients, details)

        key(`${records}.${lsize}.${csize}.${msize}`, results)(dump)
        values(clients).map(d => d.kill())
        values(cluster).map(d => d.kill())
      }

  log(str(dump))
}