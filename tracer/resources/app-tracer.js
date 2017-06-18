module.exports = async node => {
  const { pull } = ripple
      , legs     = {}
      , traces   = clone(await pull('traces', node))
      , rows     = values(traces)
      , max      = rows.reduce((p, v) => (v.recv > p ? v.recv : p), 0)
      , min      = rows.reduce((p, v) => (v.send < p ? v.send : p), Infinity)
      , per      = d => 100*(d - min)/(max - min)
      , top      = (d, i) => d.pid ? rows.findIndex(by('id', d.pid)) : i
      , format   = (id, s = id.split('-')) => `${s[0]} → ${s[1]} (${s[2]})`

  once(node)
    ('.container', 1)
      ('.row', roll(clone(traces)))
        .each(recurse)

  function recurse(node, state) {
    const row = once(node)
      
    row('.block', 1)
      .classed('is-recv', d => d.recv)
      .attr('id', d => d.pid ? `${format(d.pid)} | ${format(d.id)}`: format(d.id))
      .attr('style', (d, i) => `
        margin-left: ${per(d.send)}%;
        width: ${per(d.recv || max) - per(d.send)}%;`)

    row('.block')
      ('.send', d => d.send)
        .text(d => `${d - min}ms`)

    row('.block')
      ('.recv', d => d.recv)
        .text(d => `${d - min}ms`)

    row('.row', d => d.legs)
      .each(recurse)
  }

  function roll(traces) {
    return Object.entries(traces).reduce((p, [id,d]) => d.pid 
      ? ((traces[d.pid].legs = traces[d.pid].legs || []).push(extend(d)({ id })), p)
      : (p.push(extend(d)({ id })), p)
      , [])
  } 

}
        // height: ${((d.legs ? d.legs.length : 0) + 1) * 20}px;