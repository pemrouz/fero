const fero = require('./')
    , handler = {
        set: (o, key, value) => o.update(key, value)
      , deleteProperty: (o, key) => o.remove(key)
      }

module.exports = async (name, opts) => new Proxy(await fero(name, opts), handler)


