const { emitterify, extend } = require('utilise/pure')

const formatID = id => id.replace(/\./g, '-')

const jit = jitter => delay => delay*(1-jitter) + random()*delay*jitter

function emit(li, param1){
  if (li)
    for (let i = 0; i < li.length; i++)
      li[i](param1)
}

const last = d => d && d[d.length-1] || {}

const { random } = Math

const combine = (arr, event, combined = emitterify()) => {
  arr.map(parent => parent
    .on(event)
    .map(args => combined.emit(event, extend(args)({ parent }))))

  return combined.on(event)
}

const avg = list => (list.reduce((a, b) => a + b, 0) / list.length) 
    
module.exports = { formatID, jit, emit, last, combine, avg }