const fero = require('fero')
    , { test } = require('tap')
    , { values } = require('utilise/pure')

test('should be able to spin up multiple servers/clients in single process', async ({ same, plan }) => {
  const servers = await fero.all(Array(5).fill().map((d, i) => `test${i}`))
      , clients = await fero.all(Array(5).fill().map((d, i) => `test${i}`), { client: true })

  await Promise.all([
      ...values(servers).map(d => d.once('client'))
    , ...values(clients).map(d => d.once('connected'))
    ]
  )
  
  await values(servers).map(d => d.destroy())
  await values(clients).map(d => d.destroy())
})