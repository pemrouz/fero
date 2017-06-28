const { silent } = require('minimist')(process.argv.slice(2))
    , { emitterify, str, keys } = require('utilise/pure')
    , { fork } = require('child_process')

module.exports = file => (test, base = {}) => (d, i) => {
  const peer = emitterify()
      , proc = fork(`./tests/integration/${test}/${file}.js`, override(base, i), { silent })
    
  proc.on('message', args => peer.emit(args.type, args))
  peer.send = cmd => proc.send(cmd)
  peer.kill = cmd => proc.kill(cmd)
  peer.results = {}
  return peer
}

function override(overrides, i) {
  const args = process.argv.slice(2).concat('-i', i)

  keys(overrides)
    .map(d => ~args.indexOf(`-${d}`)
      ? args[args.indexOf(`-${d}`)+1] = str(overrides[d])
      : args.push(`-${d}`, str(overrides[d]))
    )

  return args
}