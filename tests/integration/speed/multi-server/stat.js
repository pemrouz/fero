const dp = (num, precision = 2) => ~~(num * pow(10, precision))/pow(10, precision)
    , log = require('utilise/log')('[fero/benchmark/speed]')
    , { avg } = require('../../../../utils')
    , { str } = require('utilise/pure')
    , { pow, max } = Math
    , ms = hrtime => hrtime ? dp(hrtime[0] * 1e3 + hrtime[1] * 1e-6) : '-'

module.exports = ({ msize, records }, results) => {
  const [yacks, sacks] = results.map(ms)

  log(`

${str(records).bold} records, ${str(msize).bold} bytes
  * yacks: ${dp(yacks)} ms | ${dp(records*1000/yacks)} records/sec | ${dp(records*msize*1000/yacks/1024/1024)} MB/sec
  * sacks: ${dp(sacks)} ms | ${dp(records*1000/sacks)} records/sec | ${dp(records*msize*1000/sacks/1024/1024)} MB/sec

`)
}