const Change = require('fero/messages/change')
    , { str } = require('utilise/pure')
    , padstart = require('lodash.padstart')

module.exports = (records, size) => Array(records)
  .fill()
  .map((d, i) => i)
  .map(str)
  .map(hash)
  .map(key => new Change('update', key.slice(0, 6), padstart('*', size - 9)))
  .map(change => change.buffer)

const hash = thing => require('crypto').createHash('md5').update(thing).digest('hex')