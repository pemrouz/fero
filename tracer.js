const argv = require('minimist')(process.argv)

module.exports = async ({ name }) => {
  if (!argv.trace || name == 'tracer') return false
  const tracer = await require('fero').spawn('tracer')
  await tracer.on('connected')
  return tracer
}