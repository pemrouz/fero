const { emitterify, extend, keys, is } = require('utilise/pure')

const { random, pow } = Math

const ms = hrtime => hrtime[0] * 1e3 + hrtime[1] * 1e-6

const dp = (precision = 2) => num => ~~(num * pow(10, precision))/pow(10, precision)

const formatID = id => id.replace(/\./g, '-')

const jit = jitter => delay => delay*(1-jitter) + random()*delay*jitter

function emit(li, param1){
  if (li)
    for (let i = 0; i < li.length; i++)
      li[i](param1)
}

const last = d => d && d[d.length-1] || {}


const combine = (arr, event, combined = emitterify()) => {
  arr.map(parent => parent
    .on(event)
    .map(args => combined.emit(event, extend(args)({ parent }))))

  return combined.on(event)
}

const merge = (...streams) => {
  const output = emitterify().on('change')

  keys(streams)
    .map(stream => streams[stream]
      .map(output.next)
    )

  return output
}

const stream = (input, { destroy = true, id  } = {}) => emitterify(input)
  .on('value')
  .on('start', function(){
    this.next({ type: 'update', value: input })

    input
      .on('change')
      .map(this.next)
      .until(this.once('stop'))

    this
      .once('stop')
      .filter(d => destroy)
      .map(d => input.emit('stop'))
  })
  .unpromise()

const avg = list => (list.reduce((a, b) => a + b, 0) / list.length) 

const start = o => {
  o.source.emit('start')
  return o
}    

module.exports = { formatID, jit, emit, last, combine, avg, ms, dp, merge, stream, start }