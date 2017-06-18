const prices = require('fero/peers')({ 
        name: 'prices'
      , tcp: { max: Infinity, hosts: ['127.0.0.1'], ports: [6000, 6009] }
      , retries: d => 100
      })

function loaded() {
  prices.peers.on('change', change => set(change)(ripple('peers')))
}

module.exports = { 
  name: 'prices'
, body: prices
, headers: { loaded }
}