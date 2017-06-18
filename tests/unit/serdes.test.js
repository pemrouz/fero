!async function(cases){
  const { key } = require('utilise/pure')
      , { same, equal, end } = require('tap')
      , { serialise, deserialise } = require('../../serdes')
      , Constants = require('../../constants')
      , peers = { constants: new Constants() }
      
  cases.map(([original, buffer, label, deserialised = original]) => {
    same(serialise.call(peers, original), buffer, `serialise ${label}`)
    same(key(['type', 'key', 'value'])(deserialise.call(peers, buffer)), deserialised, `deserialise ${label}`)
    equal(deserialise.call(peers, buffer).buffer, buffer, `buffer ${label}`)
  })

  process.exit(end())
}([
    [ 
      { type: 'update', key: '1', value: '3' }
    , Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x31, 0x01, 0x33])
    , 'basic update'
    ]
  , [ 
      { type: 'remove', key: '1' }
    , Buffer.from([0x00, 0x00, 0x00, 0x00, 0x02, 0x01, 0x31, 0x04])
    , 'basic remove'
    ]
  , [ 
      { type: 'add', key: '1', value: '2' }
    , Buffer.from([0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x31, 0x01, 0x32])
    , 'basic add'
    ]
  , [ 
      { type: 'update', key: 1, value: 1 }
    , Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x31, 0x02, 0x31])
    , 'ints'
    , { type: 'update', key: '1', value: 1 }
    ]
  , [ 
      { type: 'update', key: '1', value: { foo: 'bar' } }
    , Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x31, 0x03, 0x7b, 0x22, 0x66, 0x6f, 0x6f, 0x22, 0x3a, 0x22, 0x62, 0x61, 0x72, 0x22, 0x7d])
    , 'update with json'
    ]
  , [ 
      { type: 'update', value: '1' }
    , Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x31])
    , 'missing key'
    ]
  , [ 
      { type: 'update', key: '1' }
    , Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x31, 0x04])
    , 'missing value'
    ]
  , [
      { type: 'update' }
    , Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x04])
    , 'missing both'
    ]
  , [
      { type: 'foo' }
    , Buffer.from([0x00, 0x00, 0x00, 0x00, 0x07, 0x66 ,0x6f ,0x6f, 0x00, 0x04])
    , 'irregular verb'
    ]
  ]
)