module.exports = function discoverudp(peers, name, opts = {}){
  if (!opts) return deb('skip'), false
  if (peers.constants.udp.skip) return deb('skip'), false
  if (!is.obj(opts)) opts = {}

  const { ip = '224.0.0.251', port = 5354, ttl = 128 } = opts
      , socket = createSocket({ type: 'udp4', reuseAddr: true }) 
      , udp    = emitterify({ socket })
      , params = { name, socket, peers, udp, ip, port, ttl }
      
  socket
    .on('error', error(params))
    .on('message', message(params))
    .on('listening', listening(params))
    .bind(port)
    .unref()

  udp
    .multicast = multicast(params)

  udp
    .on('message', reemit(params))
    .on('holler', holler(params))
    .on('client', client(params))

  return udp
}

const error = ({ socket, udp }) => e => { 
  err('error')
  deb('error', e.stack)
  socket.close()    
  udp.emit('close') // on close instead?
}

const reemit = ({ udp }) => message => {
  // TODO: Make command fixed length
  const [command, ...args] = message.split(' ')
  udp.emit(command, args)
}

const holler = ({ name, peers }) => (rname, address) => {
  const [host, port] = address.split(':')
  if (rname == name)
    peers.create(host, port)
}

const client = ({ name, peers, udp }) => rname => {
  if (!peers.me) return;
  if (rname == name)
    udp.multicast(`holler ${name} ${peers.me.address}`) // TODO unicast vs multicast
}

const message = ({ peers, udp }) => buffer => {
  const message = buffer.toString()
  deb('recv', message.bold)
  udp.emit('message', message)
}

const listening = ({ name, peers, socket, udp, ip, port, ttl }) => () => {
  const schedule = peers.constants.udp.retry || !peers.me ? setInterval : setTimeout
  deb('init', `${peers.me && peers.me.id}`.bold)
  socket.setMulticastTTL(ttl)
  socket.addMembership(ip) 

  peers.timeouts.udp = schedule(d => 
    (peers.lists.connected.length || peers.lists.client.length)
      ? clearTimeout(peers.timeouts.udp)
      : udp.multicast(peers.me 
        ? `holler ${name} ${peers.me.address}`
        : `client ${name}`
      )
  , jit(0.5)(peers.constants.udp.jitter))
}

const multicast = ({ socket, ip, port }) => message => {
  const buffer = Buffer.from(message)
  deb('send', message.bold)
  if (socket._receiving)
    socket.send(buffer, 0, buffer.length, port, ip)
}

const format = ({ address, port }) => ({ host: address, port })

const { emitterify, is } = require('utilise/pure')
    , { createSocket } = require('dgram')
    , argv = require('minimist')(process.argv)
    , deb = require('./deb')('udp'.bgMagenta.bold)
    , err = require('utilise/err')('[fero/udp]')
    , { jit } = require('./utils')