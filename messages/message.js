// TODO: should use parameterised version
const Constants = require('../constants')
    , Change = require('./change')
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
  reply = reply instanceof Buffer ? reply
        : reply instanceof Change ? reply.buffer
        : new Change('', '', reply).buffer

  const buffer = Buffer.allocUnsafe(4 + reply.length)
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
      this._value = this.buffer[2] === constants.types.string ?  this.buffer.slice(this.buffer[1] + 3).toString()
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