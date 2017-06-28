const argv   = require('minimist')(process.argv.slice(2))
    , fero   = require('fero')
    , csize  = argv.c  || 1
    , hosts  = (argv.h || '127.0.0.1').split(',')
    , port   = argv.p  || 6000

fero('speed-test', { hosts, ports: [port, port + csize - 1], from }).then(resource => {
  // send checksum info back to parent on init and on change to track stability
  if (process.send)
    process.send({ type: 'checksum', checksum: resource.peers.dht.checksum })

  resource
    .on('checksum')
    .map(checksum => process.send({ type: 'checksum', checksum }))
})

function from(req){
  req.reply('echo')
}