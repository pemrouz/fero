const hash = str => {
  let hash = 5381
    , i = str.length

  while (i)
    hash = (hash * 33) ^ str.charCodeAt(--i)

  return hash >>> 0
}

const vnodes = 200

const { writeFileSync } = require('fs')

const peers = Array(1000).fill()
  .map(i => 
    hash(Array(i).fill()
      .map(p => '127-0-0-1:' + (6000 + p))
      .join(';'))
  )

writeFileSync('./checksums.js', `module.exports = ${JSON.stringify(peers)}`)