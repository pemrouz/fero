const { promise, emitterify } = require('utilise/pure')
    , generate    = require('../../../utils/generate-messages')
    , argv        = require('minimist')(process.argv.slice(2))
    , records     = +argv.r || 1000000
    , msize       = +argv.m || 100
    , csize       = +argv.c || 1
    , port        = +argv.p || 6000
    , hosts       = (argv.h || '127.0.0.1').split(',')
    , zero        = process.hrtime()
    , worker      = !!process.send
    , { min }     = Math

require('fero')('speed-test', { hosts, ports: [port, port + csize - 1], client: true }).then(resource => {
  resource
    .on('connected')
    .filter(d => resource.peers.lists.connected.length == min(csize, resource.peers.connections))
    .map(d => {
      process.send({ type: 'connected', connected: process.hrtime(zero) })
      process.on('message', async d => {
        const messages = generate(records, msize)

        const sacks = resource
          .on('reply')
          .reduce(acc => ++acc, 0)
          .filter(acc => acc === records)
          .then(d => process.hrtime(start))

        const tacks = resource
          .on('tack')
          .reduce((acc, m) => (acc += (-(m.peer.tackz || 0) + (m.peer.tackz = m.value))), 0)
          .filter(total => total == records)
          .map(d => process.hrtime(start))

        const yacks = resource
          .on('ack')
          .reduce((acc, m) => (acc += (-(m.peer.yacks || 0) + (m.peer.yacks = m.value))), 0)
          .filter(total => total == records)
          .map(d => process.hrtime(start))

        const start = process.hrtime()

        for (var i = 0; i < messages.length; i++)
          resource.peers.send(messages[i])

        const results = await Promise.all([tacks, yacks, sacks])
            , acks = { tacks: results[0], yacks: results[1], sacks: results[2] }
            
        process.send({ type: 'acks', acks })

        if (!worker) 
          require('./stat')({ lsize: 1, csize, msize, records })(acks)
      })
    })
  

  if (!worker) {
    process.send = String
    process.on = (t, fn) => fn()
  }
  
})