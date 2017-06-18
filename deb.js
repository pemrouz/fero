module.exports = ns => (...args) => deb.apply(null, [ns].concat(str(index)[colors[index % 3]], ...args))
// module.exports = () => () => {}

require('colors')
const uuid = d => ~~(Math.random()*10)
    , { str } = require('utilise/pure')
    , { index = uuid() } = require('minimist')(process.argv.slice(2))
    , deb       = require('utilise/deb')(`[fero]`)
    , colors  = {
        0: 'red' 
      , 1: 'green' 
      , 2: 'blue' 
      }


    // , { to } = require('utilise/pure')
    // , deb             = require('utilise/deb')(`[fero] ${index}`)
    // , { appendFile }  = require('fs')
    // , append = args => (appendFile(`./logs/${index}.log`, [index].concat(args).concat('\n').join(' '), d => d), args)