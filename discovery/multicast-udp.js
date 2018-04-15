module.exports = function(opts){
  const socket = createSocket({ type: 'udp4', reuseAddr: true }) 
      , parent = emitterify({ 
          multicast: multicast(socket, opts) 
        , close: close(socket)
        })

  socket
    .on('close', closed(parent, socket))
    .on('error', error(parent, socket))
    .on('message', message(parent))
    .on('listening', listening(parent, socket, opts))
    .bind(opts.port)
    .unref()

  return parent
}

const close = socket => () => new Promise(resolve => 
  socket.close(resolve)
)

const message = parent => buffer => {
  // TODO: Make command fixed length
  const message = buffer.toString()
  const [command, ...args] = message.split(' ')
  parent.emit(command, args)
}

const listening = (parent, socket, { ip, port, ttl }) => () => {
  socket.setMulticastTTL(ttl)
  socket.addMembership(ip) 
  parent.emit('listen')
}

const multicast = (socket, { ip, port }) => message => new Promise(resolve => {
  const buffer = Buffer.from(message)
  deb('send', message.bold, socket._receiving)
  if (socket._receiving)
    socket.send(buffer, 0, buffer.length, port, ip, resolve)
  else {
    deb('unable to send'.red, message) 
    resolve()
  }
})

const closed = (parent, socket) => e => { 
  deb('close', e || '')
  parent.emit('close')
}

const error = (parent, socket) => e => { 
  err('error', e.stack)
  socket.close()
}

const { emitterify } = require('utilise/pure')
    , { createSocket } = require('dgram')
    , err = require('utilise/err')('[fero/udp]')
    , deb = require('../deb')('mul'.bgMagenta.bold)