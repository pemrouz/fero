const { messages = 10000 } = require('minimist')(process.argv)
    , { avg, ms, dp } = require('../../../../utils')
    , { delay, az } = require('utilise/pure')
    , fero = require('fero')
    
fero('test', { client: true })
  .then(async me => (await me.on('connected'), me))
  .then(me => {
    let latencies = []
      , { peers } = me 

    !function send(){
      const start = process.hrtime()
      peers
        .send('foooo')
        .on('ack', d => latencies.push(process.hrtime(start)) == messages 
          ? finish() 
          : send()
        )
    }()

  function finish(argument) {
    latencies = latencies.map(ms).map(dp(2)).sort(az(d => d))
    console.log("            mean", dp(2)(latencies.reduce((p,v) => p+v, 0)/latencies.length), 'ms')
    console.log("10    percentile", latencies[~~(latencies.length*0.1)], 'ms')
    console.log("50    percentile", latencies[~~(latencies.length*0.5)], 'ms')
    console.log("90    percentile", latencies[~~(latencies.length*0.9)], 'ms')
    console.log("99    percentile", latencies[~~(latencies.length*0.99)], 'ms')
    console.log("99.9  percentile", latencies[~~(latencies.length*0.999)], 'ms')
    console.log("99.99 percentile", latencies[~~(latencies.length*0.9999)], 'ms')
    me.destroy()
  }
})