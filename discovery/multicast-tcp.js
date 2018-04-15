module.exports = function({ host, port }){
  const socket = fero('mtcp', { 
          client: true
        , hosts: [host]
        , ports: [port]
        , multicast: false 
        , retries: { max: Infinity }
        , outbox: { max: 1000 }
        })
      , parent = emitterify()
      
  socket.then(async socket => {
    socket.on('change', message(parent))
  
    parent.close = () => socket.destroy()
    parent.multicast = message => {
      deb('send', message.bold)
      socket.peers.send(message)
    }

    await Promise.race([delay(1000), socket.once('connected')])
    parent.emit('listen')
  })

  return parent
}

const message = (parent, socket) => change => {
  const [command, ...args] = change.value.split(' ')
  parent.emit(command, args)
}

const { delay, emitterify } = require('utilise/pure')
    , fero = require('..')
    , deb = require('../deb')('mul'.bgMagenta.bold)