module.exports = Ack

function Ack(buffer, peer) {
  this.value = buffer.readDoubleBE()
  this.peer = peer
}