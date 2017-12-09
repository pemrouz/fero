module.exports = function discoverudp(
  peers = { constants: new Constants() }
, name = 'ghost'
, opts = {}
){
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

  if (peers.constants.udp.monitor && peers.cache) {
    merge(
      stream(peers.cache).pipe(start)
    , peers.cache.on('status')
    , udp.once('listening')
    , udp
        .on('list')
        .filter(([rname, id]) => ((!rname || rname == name) && !id))
    )
    .on('start', function(){
      process.on('SIGINT', () => {
        this.source.emit('stop')
        time(1000, () => process.exit(1))
      })
    })
    .on('stop', () => udp.multicast(`stop ${peers.uuid}`))
    .pipe(o => o.each(debounce(12)((d , i, n) => n.next(d))))
    .filter((d, i, n) => !('reason' in n.source))
    .map(() => udp.multicast([
        'list'
      , name
      , peers.me ? peers.me.id : 'client'
      , peers.uuid || ''
      , peers.dht.checksum
      , keys(peers.cache.partitions.heads()).length
      , values(peers.cache.partitions.heads()).reduce(((p, v) => p + v.head), 0)
      ].join(' ')
    ))
    .until(udp.on('stop').filter(d => !is.arr(d) || !d[0]))
    .source.emit('start')
  }

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
  deb('init', `${peers.me ? peers.me.id : name}`.bold)
  socket.setMulticastTTL(ttl)
  socket.addMembership(ip) 

  udp.emit('listening')
  if (!(peers instanceof Peers)) return
  const schedule = peers.constants.udp.retry || !peers.me ? setInterval : setTimeout

  peers.timeouts.udp = schedule(d => 
    (peers.lists.connected.length || peers.lists.client.length)
      ? clearTimeout(peers.timeouts.udp)
      : udp.multicast(peers.me 
        ? `holler ${name} ${peers.me.address}`
        : `client ${name}`
      )
  , jit(0.5)(peers.constants.udp.jitter))
}

const multicast = ({ socket, ip, port }) => message => new Promise(resolve => {
  const buffer = Buffer.from(message)
  deb('send', message.bold, socket._receiving)
  if (socket._receiving)
    socket.send(buffer, 0, buffer.length, port, ip, resolve)
})

const format = ({ address, port }) => ({ host: address, port })

process.setMaxListeners(200)
const { emitterify, is, keys, str, debounce, values, time } = require('utilise/pure')
    , { jit, merge, stream, start } = require('./utils')
    , { createSocket } = require('dgram')
    , Constants = require('./constants')
    , Peers = require('./peers')
    , argv = require('minimist')(process.argv)
    , deb = require('./deb')('udp'.bgMagenta.bold)
    , err = require('utilise/err')('[fero/udp]')