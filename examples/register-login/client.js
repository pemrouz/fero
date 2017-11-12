const fero = require('fero')

async function register(users) {
  const data = await users.peers.send({
    type: 'REGISTER',
    value: {
      user: 'foo',
      password: '1234'
    }
  }).on('reply')

  console.log('REGISTER RESPONSE:', data.value)
}

async function login(users) {
  const data = await users.peers.send({
    type: 'LOGIN',
    value: {
      user: 'foo',
      password: '1234'
    }
  }).on('reply')

  console.log('LOGIN RESPONSE:', data.value)
}

!async function start(){
  const users = await fero('users', { client: true })
  await users.once('connected')

  await register(users)
  await login(users)
}()