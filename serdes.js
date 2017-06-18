module.exports = { serialise, deserialise }

function serialise({ type, key, value, ptime = 0 }){
  if (typeof key !== 'string') key = typeof key === 'number' ? ''+key : ''
  const vtype = typeof value === 'object'    ? (value = JSON.stringify(value), this.constants.types.json)
              : typeof value === 'undefined' ? (value = ''                   , this.constants.types.undefined)
              : typeof value === 'number'    ? (value = ''+value             , this.constants.types.number)
                                             : (this.constants.types.string)
  if (this.constants.change[type]) {
    const buffer = Buffer.allocUnsafe(7 + key.length + value.length) // TODO recycle buffers
    buffer[0] = buffer[1] = buffer[2] = buffer[3] = 0
    buffer.writeUInt16LE(ptime)
    buffer[4] = this.constants.change[type]
    buffer[5] = key.length
    buffer.fill(key, 6, 6 + key.length)
    buffer[6 + key.length] = vtypeF
    buffer.fill(value, 7 + key.length)
    return buffer
  } else {
    const buffer = Buffer.allocUnsafe(7 + key.length + value.length + type.length)
    buffer[0] = buffer[1] = buffer[2] = buffer[3] = 0
    buffer.writeUInt16LE(ptime)
    buffer[4] = type.length + this.constants.change.variable
    buffer.fill(type, 5, 5+type.length)
    buffer[5+type.length] = key.length
    buffer.fill(key, 6+type.length, 6+type.length+key.length)
    buffer[6+type.length+key.length] = vtype
    buffer.fill(value, 7+type.length+key.length)
    return buffer
  }
}

function deserialise(buffer) {
  let change = {}, koffset = 5, voffset
  change.ptime = buffer.readUInt16LE()
  if (buffer[4] < this.constants.change.variable) 
    change.type  = this.constants.change[buffer[4]]
  else {
    koffset += (buffer[4] - this.constants.change.variable)
    change.type = buffer.slice(5, koffset).toString()
  }
  change.key   = buffer.slice(koffset+1, voffset = buffer[koffset] + koffset+1).toString() || undefined
  change.value = buffer[voffset] === this.constants.types.json      ? JSON.parse(buffer.slice(voffset + 1).toString())
               : buffer[voffset] === this.constants.types.undefined ? undefined
               : buffer[voffset] === this.constants.types.number    ? +buffer.slice(voffset + 1).toString()
                                                                    : buffer.slice(voffset + 1).toString()
  change.buffer = buffer
  return change
}