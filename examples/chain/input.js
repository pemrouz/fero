// top-level await workaround
!async function(){

  // input resource
  const input = await require('fero')('input')

  // // wait till a client is connected
  // await input.on('client') 

  // // add a new key/value every second
  // let i = 0
  // setInterval(d => { 
  //   console.log('input', i)
  //   update('P' + i, i++)(input)
  // }, 1000)

}()