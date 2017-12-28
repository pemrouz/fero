module.exports = exports = async (name = '*', opts = {}) => {
  if (is.fn(opts)) opts = { from: opts }
  const server = await (opts.client ? false : Server(opts.ports))
  return new Cache(extend({ name, server })(opts))
}

exports.all = async (names, opts) => 
  (await Promise.all(names.map(name => exports(name, opts))))
    .reduce(to.obj(cache => cache.peers.name), {})

exports.connect = require('./connect')

exports.fero = exports 

const { extend, is, to } = require('utilise/pure')
    , Server = require('./server')
    , Cache  = require('./cache')