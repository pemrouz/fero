// TODO: should use parameterised version
const Constants = require('./constants')
    , constants = new Constants() 
    , deb = require('./deb')('cha'.bgBlack.bold)
    , define = Object.defineProperty
    , { extend, str, parse, is, clone } = require('utilise/pure')

module.exports = Change

function Change(type, key, value){
  if (typeof arguments[0] === 'object') {
    this._key = arguments[0].key
    this._type = arguments[0].type
    this._value = typeof arguments[0].value === 'object' ? clone(arguments[0].value) : arguments[0].value
  } else {
    this._key = key
    this._type = type
    this._value = typeof value === 'object' ? clone(value) : value
  }
}

Change.fromBuffer = function(buffer, peer, command, tack){
  this._buffer = buffer
  this.peer = peer
  this.command = command
  this.tack = tack
}

Change.fromBuffer.prototype = Change.prototype
// extend(Change.prototype, Change.fromBuffer.prototype)

Change.prototype.reply = function(reply) {
  if (!reply.length || reply instanceof Array) reply = str(reply) 
  const buffer = Buffer.allocUnsafe(4 + reply.length) // TODO: why slow?
  buffer.writeUInt32LE(this.tack)
  buffer.fill(reply, 4)
  this.peer.send(buffer, constants.commands.reply)
}


// lazy getters, only serialise/deserialise on first access
define(Change.prototype, 'buffer', {
  // TODO (perf): check impact of undefined check vs falsy vs typeof
  get: function(){ return this._buffer !== undefined ? this._buffer : this.serialise() }
})

define(Change.prototype, 'key', {
  enumerable: true
  // TODO (perf): check impact of undefined check vs falsy vs typeof
, get: function(){ 
    return this._key !== undefined ? this._key : (
      this._key = this._buffer.slice(3, this._buffer[1] + 3).toString() || null
    ) 
  }
})

define(Change.prototype, 'value', {
  enumerable: true
  // TODO (perf): check impact of undefined check vs falsy vs typeof
, get: function(){ 
    return this._value !== undefined ? this._value : (this._buffer && (
      this._value = this._buffer[2] === constants.types.string ? this._buffer.slice(this._buffer[1] + 3).toString()
                  : this._buffer[2] === constants.types.number ? +this._buffer.slice(this._buffer[1] + 3).toString()
                  : this._buffer[2] === constants.types.json   ? JSON.parse(this._buffer.slice(this._buffer[1] + 3).toString())
                                                               : undefined
      ))
    }
})

define(Change.prototype, 'type', {
  enumerable: true
  // TODO (perf): check impact of undefined check vs falsy vs typeof
, get: function(){ return this._type || (this._type = constants.change[this._buffer[0]]) }
})

// Change.prototype.deserialise = function() {
//   this._type  = constants.change[this._buffer[0]]
//   this._key   = this._buffer.slice(1, this._buffer[1] + 1).toString() || undefined
//   this._value = this._buffer[2] === constants.types.string ? this._buffer.slice(this._buffer[1] + 3).toString()
//               : this._buffer[2] === constants.types.number ? +this._buffer.slice(this._buffer[1] + 3).toString()
//               : this._buffer[2] === constants.types.json   ? JSON.parse(this._buffer.slice(this._buffer[1] + 3).toString())
//                                                            : undefined
//   return this
// }

Change.prototype.text = function(){
  return this.buffer.toString()
}

Change.prototype.json = function(){
  return parse(this.text())
}

// TODO: serdes as int, not string
Change.prototype.number = function(){
  return +this.text()
}

Change.prototype.serialise = function() {
  if (typeof this._key !== 'string') 
    this._key = typeof this._key === 'number' ? ''+this._key : ''
  
  let v
  /// TODO: Add boolean type too
  const vtype = typeof this._value === 'object'    ? (v = JSON.stringify(this._value), constants.types.json)
              : typeof this._value === 'undefined' ? (v = ''                         , constants.types.undefined)
              : typeof this._value === 'number'    ? (v = ''+this._value             , constants.types.number)
                                                   : (v = this._value                , constants.types.string)
  this._buffer = Buffer.allocUnsafe(3 + this._key.length + v.length) // TODO recycle buffers
  this._buffer[0] = constants.change[this._type]
  this._buffer[1] = this._key.length
  this._buffer[2] = vtype
  this._buffer.fill(this._key, 3, 3 + this._key.length)
  this._buffer.fill(v, 3 + this._key.length)
  return this._buffer
}