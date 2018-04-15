const fero = require('fero')
    , from = (req, cache) => cache.update('last', req.value)

fero('mtcp', { 
  from
, ports: [3130]
, multicast: false
})