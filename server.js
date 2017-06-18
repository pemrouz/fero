module.exports = (bounds = [0, 0]) => {
  const [start, end = start] = bounds
      , ports = shuffle(Array(1 + end - start).fill().map((d, i) => i + start))
      , server = emitterify({})

  server
    .on('scan')
    .filter((d, i, n) => delay(i*3, d).then(n.next))
    .filter(d => !server.id)
    .map(d => createServer()
      .on('error', error(d))
      .listen(d, '127.0.0.1', listen(server))
    )

  ports.map(port => server.emit('scan', port))

  return server.on('init')
}

const error = port => e => e.code == 'EADDRINUSE' 
  ? deb('tcp used', port) 
  : err('unhandled', e)

const listen = server => function(){
  if (server.id) {
    deb('tcp overshoot', this.address())
    return this.close()
  }

  def(server, 'raw'    , this)
  def(server, 'host'   , server.raw.address().address)
  def(server, 'port'   , server.raw.address().port)
  def(server, 'address', `${server.host}:${server.port}`)
  def(server, 'id'     , formatID(server.address))
  def(server, 'uuid'   , ' me ')
  deb('init', server.id.bold)
  server.emit('init', server)
}

const { formatID } = require('./utils')

const deb = require('./deb')('srv'.bgCyan.bold)
    , err = require('utilise/err')('[fero/srv]')
    , shuffle = require('lodash.shuffle')
    , { createServer } = require('net') 
    , { jit } = require('./utils')

const { delay, def, emitterify } = require('utilise/pure')