const dp = (num, precision = 2) => ~~(num * pow(10, precision))/pow(10, precision)
    , log = require('utilise/log')('[fero/benchmark/speed]')
    , { avg } = require('../../../../utils')
    , { str } = require('utilise/pure')
    , { pow, max } = Math
    , ms = hrtime => hrtime ? (hrtime[0] * 1e3 + hrtime[1] * 1e-6) : '-'

const breakdown = results => ({
  avg: avg(results)
, max: max(...results)
})

module.exports = ({ csize, lsize, msize, records }, cluster, clients) => {
  const results = {
          connected: breakdown(clients.map(d => ms(d.connected)))
        , stable   : breakdown(cluster.map(d => ms(d.stable)))
        , tacks    : breakdown(clients.map(d => ms(d.tacks)))
        , yacks    : breakdown(clients.map(d => ms(d.yacks)))
        }
      , { stable, connected, tacks, yacks } = results

  log(`\n${str(records).bold} records, ${str(csize).bold} peers, ${str(lsize).bold} clients, ${str(msize).bold} bytes
  * stable: ${dp(stable.avg)} ms, (max ${dp(stable.max)}) ms
  * connected: ${dp(connected.avg)} ms, (max ${dp(connected.max)}) ms
  * tacks: ${dp(tacks.avg)} ms (max ${dp(tacks.max/1000)} sec) | ${dp(records*1000/tacks.avg)} records/sec | ${dp(records*msize*1000/tacks.avg/1024/1024)} MB/sec
  * yacks: ${dp(yacks.avg)} ms (max ${dp(yacks.max/1000)} sec) | ${dp(records*1000/yacks.avg)} records/sec | ${dp(records*msize*1000/yacks.avg/1024/1024)} MB/sec`)

  return results
}