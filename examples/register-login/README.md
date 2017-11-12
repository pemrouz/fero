```
$ node ./server.js
READY1
REGISTER { type: 'REGISTER', value: { user: 'foo', password: '1234' } }
LOGIN { type: 'LOGIN', value: { user: 'foo', password: '1234' } }
```

```
$ node ./client.js
REGISTER RESPONSE: [ 200, 'ok' ]
LOGIN RESPONSE: [ 200, 'ok' ]
```