module.exports = function multicast(
  peers = { 
    constants: new Constants()
  , name: 'ghost' 
  }
){
  if (!peers.constants.multicast)
    return deb('skip'), false
  
  const { type } = peers.constants.multicast
      , socket = require(`./multicast-${type}`)(peers.constants.multicast)

  socket
    .on('holler', holler(peers, socket))
    .on('client', client(peers, socket))
    .on('listen', listen(peers, socket))

  if (peers.constants.multicast.monitor && peers instanceof Peers) {
    merge(
      stream(peers.cache).pipe(start)
    , peers.cache.on('status')
    , socket.once('listen')
    , socket
        .on('list')
        .filter(([rname, id]) => ((!rname || rname == peers.name) && !id))
    )
    .on('start', function(){
      process.on('SIGINT', () => {
        this.source.emit('stop')
        time(1000, () => process.exit(1))
      })
    })
    .on('stop', () => socket.multicast(`stop ${peers.uuid}`))
    .pipe(o => o.each(debounce(12)((d, i, n) => n.next(d))))
    .filter((d, i, n) => !('reason' in n.source))
    .map(() => socket.multicast([
        'list'
      , peers.name
      , peers.me ? peers.me.id : 'client'
      , peers.uuid || ''
      , peers.dht.checksum
      , keys(peers.cache.partitions.heads()).length
      , values(peers.cache.partitions.heads()).reduce(((p, v) => p + v.head), 0)
      ].join(' ')
    ))
    .until(socket.on('stop').filter(d => !is.arr(d) || !d[0]))
    .source.emit('start')
  }

  return socket
}

const holler = peers => (rname, address) => {
  deb('holler', rname, address)
  const [host, port] = address.split(':')
  if (rname == peers.name)
    peers.create(host, port)
}

const client = (peers, socket) => rname => {
  deb('client', rname)
  if (!peers.me) return;
  if (rname == peers.name)
    socket.multicast(`holler ${peers.name} ${peers.me.address}`) // TODO unicast vs multicast
}

const listen = (peers, socket) => {
  deb('init', `${peers.me ? peers.me.id : peers.name}`.bold)
    
  if (!(peers instanceof Peers)) return
  const schedule = peers.constants.multicast.retry || !peers.me ? setInterval : setTimeout
    
  peers.timeouts.multicast = schedule(() => 
    (peers.lists.connected.length || peers.lists.client.length)
      ? clearTimeout(peers.timeouts.multicast)
      : socket.multicast(peers.me 
        ? `holler ${peers.name} ${peers.me.address}`
        : `client ${peers.name}`
      )
  , jit(0.5)(peers.constants.multicast.jitter))
}

process.setMaxListeners(200)
const { is, keys, str, debounce, values, time } = require('utilise/pure')
    , { jit, merge, stream, start } = require('../utils')
    , Constants = require('../constants')
    , Peers = require('../peers')
    , deb = require('../deb')('mul'.bgMagenta.bold)
