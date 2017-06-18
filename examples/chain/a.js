// top-level await workaround
!async function(){

  // input resource client
  const input = await require('fero')({ name: 'input', client: 'service-a' })

  // create output distributed resource
  const output = await require('fero')('service-a')

  // observable of changes
  input
    .on('change')  
    .map(d => d.value * 2)
    .map(d => (update(d, d)(output), d))
    .map(d => console.log('change (a)', d))

  input
    .on('commit')
    .map(d => console.log("commit (a)", d))

}()