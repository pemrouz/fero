const fero = require('fero')
    , users = []

const register = req => {
  console.log("REGISTER", req.value)
  users.push(req.value)
  return [200, 'ok']
}

const login = req => {
  console.log("LOGIN", req.value)
  const { user, password } = req.value

  if (users.find(u => user === u.user && password === u.password )) {
    return [200, 'ok']
  }

  return [401, 'not authorized']
}

!async function start () {
  const users = await fero('users', async req =>
      req.value.type == 'LOGIN'    ? login(req)
    : req.value.type == 'REGISTER' ? register(req)
                                   : [405, 'method not allowed'])

  users
    .on('change')
    .map(({ key, value }) => console.log(key, value))

  console.log('READY1')
}()