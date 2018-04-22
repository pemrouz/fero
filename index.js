module.exports = exports = async (name = '*', opts = {}) => {
  if (is.fn(opts)) opts = { from: opts }
  opts = new Constants(opts)
  const server = await (opts.client ? false : Server(opts))
  return new Cache(name, server, opts)
}

exports.all = async (names, opts) => 
  (await Promise.all(names.map(name => exports(name, opts))))
    .reduce(to.obj(cache => cache.peers.logical), {})

exports.connect = require('./connect')

exports.fero = exports 

const { extend, is, to } = require('utilise/pure')
    , Constants = require('./constants')
    , Server = require('./server')
    , Cache  = require('./cache')