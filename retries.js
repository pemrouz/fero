module.exports = Retries

function Retries({ base, max, cap, jitter } = {}){
  this.base   = base
  this.max    = max
  this.cap    = cap
  this.jitter = jitter
}

Retries.prototype.retry = function(attempt){
  // console.log("retry", attempt, this.jitter, this.cap, this.base, jit(this.jitter, min(this.cap, this.base * pow(2, attempt))))
  return jit(this.jitter, min(this.cap, this.base * pow(2, attempt)))
}

const { is } = require('utilise/pure')
    , { min, pow, random } = Math
    , jit = (jitter, delay) => delay*(1-jitter) + random()*delay*jitter