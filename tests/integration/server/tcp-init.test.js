const fero = require('fero')
    , { first, last, emitterify } = require('utilise/pure')
    , { test } = require('tap')
    , ports = [6000, 6002]
    
test('should use unused ports in specified range', async function(){
  const { createServer } = require('net')
      , server1 = await fero('test', { ports })
      , server2 = await fero('test', { ports })
      , server3 = await fero('test', { ports })
      , scan  = emitterify()

  for (let port = first(ports); port <= last(ports); port++) {
    createServer()
      .on('error', ({ code }) => code == 'EADDRINUSE' 
        ? scan.emit('used') 
        : process.exit(1)
      )
      .on('listening', d => process.exit(2))
      .listen(port, '127.0.0.1')
  }
  
  scan
    .on('used')
    .reduce(acc => ++acc, 0)
    .filter(d => d == 2)
    .map(d => process.exit(0))
})