const { promise, emitterify } = require('utilise/pure')
    , generate    = require('../../../utils/generate-messages')
    , argv        = require('minimist')(process.argv.slice(2))
    , fero        = require('fero')
    , lsize       = +argv.l || 1
    , msize       = +argv.m || 100
    , csize       = +argv.c || 1
    , port        = +argv.p || 6000
    , index       = +argv.i || 0
    , hosts       = (argv.h || '127.0.0.1').split(',')
    , records     = ~~((+argv.r || 1000000)/lsize)
    , zero        = process.hrtime()
    , worker      = !!process.send
    , { min }     = Math
    , offset      = index % csize

// console.log("records", records)
// console.log("argv", argv)
// console.log("argv.m", argv.m)
// console.log("msize", msize)
// console.log("csize", csize)
// console.log("index", index)
// console.log("offset", port + index % csize)

fero('speed-test', { hosts, ports: [port + index % csize, port + offset], client: true }).then(resource => {
  resource
    .on('connected')
    // .map(d => (console.log("d", resource.peers.lists.connected.length, csize, resource.peers.connections, min(csize, resource.peers.connections)),d))
    .filter(d => resource.peers.lists.connected.length == min(csize, resource.peers.connections))
    .map(d => {
      // console.log("2", 2)
      process.send({ type: 'connected', connected: process.hrtime(zero) })
      process.on('message', async d => {
        const messages = generate(records, msize)
// console.log("messages[0].length", msize, messages[0].length)
        const tacks = resource
          .on('tack')
          .reduce((acc, m) => (acc += (-(m.peer.tackz || 0) + (m.peer.tackz = m.value))), 0)
          // .map(d => (console.log("t", d, records), d))
          .filter(total => total == records)
          // .filter(message => message.value == records)
          .map(d => process.hrtime(start))

        const yacks = resource
          .on('ack')
          // .on('ack', function(m){
            // console.log("y", m.buffer, m.buffer.readDoubleBE())
          //   if (m.buffer.readDoubleBE() == records) 
          //     yacks.resolve(process.hrtime(start))
          // })
          .reduce((acc, m) => (acc += (-(m.peer.yacks || 0) + (m.peer.yacks = m.value))), 0)
          // .map(d => (console.log("y", d, records), d))
          // .map(d => (console.log("y", d.buffer.readDoubleBE(), records), d))
          // .filter(message => message.buffer.readDoubleBE() == records)
          .filter(total => total == records)
          .map(d => process.hrtime(start))

        const start = process.hrtime()
        for (var i = 0; i < messages.length; i++)
          resource.peers.send(messages[i])
          // resource.peers.lists.connected[0].send(messages[i])
    
        let acks = await Promise.all([
          tacks
        , yacks
        ])

        acks = { tacks: acks[0], yacks: acks[1] }

        process.send({ type: 'acks', acks})

        if (!worker) 
          require('./stat')({ lsize, csize, msize, records }, [], [acks])
      })
    })
  

  if (!worker) {
    process.send = String
    process.on = (t, fn) => fn()
  }
  
})