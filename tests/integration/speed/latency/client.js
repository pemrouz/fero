const { avg } = require('../../../../utils')
    , { delay, az } = require('utilise/pure')
    , { pow } = Math
    , fero = require('fero')
    , ms = hrtime => hrtime[0] * 1e3 + hrtime[1] * 1e-6
    , dp = (precision = 2) => num => ~~(num * pow(10, precision))/pow(10, precision)
    , { messages = 100 } = require('minimist')(process.argv)
    
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
    console.log("mean", latencies.reduce((p,v) => p+v, 0) /latencies.length)
    console.log("10 percentile", latencies[~~(latencies.length*0.1)])
    console.log("50 percentile", latencies[~~(latencies.length*0.5)])
    console.log("90 percentile", latencies[~~(latencies.length*0.9)])
    console.log("99 percentile", latencies[~~(latencies.length*0.99)])
    
    me.destroy()
  }
})