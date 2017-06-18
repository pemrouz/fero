module.exports = (node, { peers }) => {
  const o = once(node)
    ('.peers', values(peers))

  o('span.host', 1)
    .text(d => d.host)

  o('span.port', 1)
    .text(d => d.port)

  o('span.rid', 1)
    .text(d => d.rid)

  o('span.status', 1)
    .text(d => d.status)
}