const argv   = require('minimist')(process.argv.slice(2))
    , fero   = require('fero')
    , csize  = argv.c  || 1
    , hosts  = (argv.h || '127.0.0.1').split(',')
    , port   = argv.p  || 6000
// console.log("process.argv", process.argv)
// console.log("argv", argv)
// console.log("port", port, csize, typeof port, typeof csize)
fero('speed-test', { hosts, ports: [port, port + csize - 1], from }).then(resource => {
  // send checksum info back to parent on init and on change to track stability
  if (process.send)
    process.send({ type: 'checksum', checksum: resource.peers.dht.checksum })
// console.log("1", 1)
  resource
    .on('checksum')
    .map(checksum => process.send({ type: 'checksum', checksum }))
})

function from(req){
  req.reply('echo')
}