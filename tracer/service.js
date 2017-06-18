require('fero')({ name: 'tracer', server: true, from })

function from(req, res, { resource, sender }) {
  const { type } = resource.peers.deserialise(req)
  
  if (type == 'dump')
    console.log("resource", str(resource))
  else 
    resource.change(req)
}