// BISMIHI
// BISMILLAHNOOR
module.exports = exports = async (name = '*', opts = {}) => {
  if (is.fn(opts)) opts = { from: opts }
  const server  = await (opts.client ? false : Server(opts.ports))
      // , tracer  = await Tracer(opts)

  // return restore(opts, new Cache(extend({ name, server, tracer })(opts)))
  return restore(opts, new Cache(extend({ name, server/*, tracer*/ })(opts)))
}

exports.all = async (names, opts) => 
  (await Promise.all(names.map(name => exports(name, opts))))
    .reduce(to.obj(d => d.peers.name), {})

const { extend, def, is, to } = require('utilise/pure')
    , Server = require('./server')
    // , Tracer = require('./tracer')
    , Cache  = require('./cache')
    , { restore } = Cache