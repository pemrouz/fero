// TODO: should use parameterised version
const Constants = require('../constants')
    , constants = new Constants() 
    , deb = require('../deb')('mes'.bgBlack.bold)
    , define = Object.defineProperty
    , { extend, str, parse, is, clone } = require('utilise/pure')

module.exports = Message

function Message(buffer, peer, command, tack){
  this.buffer = buffer
  this.peer = peer
  this.command = command
  this.tack = tack
}

Message.prototype.reply = function(reply) {
  if (!reply.length || reply instanceof Array) reply = str(reply) 
  const buffer = Buffer.allocUnsafe(4 + Buffer.byteLength(reply))
  buffer.writeUInt32LE(this.tack)
  buffer.fill(reply, 4)
  this.peer.send(buffer, constants.commands.reply)
}

// lazy getters, only serialise/deserialise on first access
define(Message.prototype, 'key', {
  enumerable: true
  // TODO (perf): check impact of undefined check vs falsy vs typeof
, get: function(){ 
    return this._key !== undefined ? this._key : (
      this._key = this.buffer.slice(3, this.buffer[1] + 3).toString() || null
    ) 
  }
})

define(Message.prototype, 'value', {
  enumerable: true
  // TODO (perf): check impact of undefined check vs falsy vs typeof
, get: function(){ 
    return this._value !== undefined ? this._value : (this.buffer && (
      this._value = this.buffer[2] === constants.types.string ? this.buffer.slice(this.buffer[1] + 3).toString()
                  : this.buffer[2] === constants.types.number ? +this.buffer.slice(this.buffer[1] + 3).toString()
                  : this.buffer[2] === constants.types.json   ? JSON.parse(this.buffer.slice(this.buffer[1] + 3).toString())
                                                               : undefined
      ))
    }
})

define(Message.prototype, 'type', {
  enumerable: true
  // TODO (perf): check impact of undefined check vs falsy vs typeof
, get: function(){ return this._type || (this._type = constants.change[this.buffer[0]]) }
})

Message.prototype.text = function(){
  return this.buffer.toString()
}

Message.prototype.json = function(){
  return parse(this.text())
}

// TODO: serdes as int, not string
Message.prototype.number = function(){
  return +this.text()
}