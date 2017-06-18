// top-level await workaround
!async function(){

  // input resource
  const input = await require('fero')('service-b')
      
  // observable of changes
  input
    .on('change')  
    .map(d => console.log('output', d.value))
    
}()