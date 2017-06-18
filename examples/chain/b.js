// top-level await workaround
!async function(){

  // input resource
  const input = await require('fero')('service-a')
      
  // create output distributed resource
  const output = await require('fero')({ name: 'service-b', server: true })

  // observable of changes
  input
    .on('change')  
    .map(d => (console.log('service-b input', d), d))
    .map(d => d.value + 10)
    .map(d => (update(d, d)(output), d))
    .map(d => console.log('service-b', d))

}()