const ripple = require('rijs')({ dir: __dirname, port: 8000 })

// ripple.on('change', (name, change) => console.log("change", name, change))
ripple
  .resource('traces', require('fero')('tracer'))

setInterval(d => console.log("ripple.resources.traces.body", ripple.resources.traces.body), 2000)