module.exports = function scan(peers, hosts, ports){
  const space = generate(hosts, ports, peers.me)

  def(peers, 'size', space.length)
  deb(`max peers ${str(peers.connections).green}/${str(space.length).green}`)

  shuffle(space)
    .map(d => d.split(':'))
    .map((d, i) => time(i*50, _ => peers.create(d[0], d[1], null, true)))
}

const deb = require('../deb')('tcp'.bgYellow.bold)
    , shuffle = require('lodash.shuffle')
    , { is, def, str, time } = require('utilise/pure')

const generate = (hosts, ports, me) => {
  if (is.str(hosts)) hosts = hosts.split(',') // TODO handle this in constants
  deb('generate space', hosts.join(', '), ports.join(','))
  const [start, end = start] = ports
      , space = []

  for (const host of hosts)
    for (let port = start; port <= end; port++)
      if (!me || me.address != `${host}:${port}`)
        space.push(`${host}:${port}`)

  return space
}