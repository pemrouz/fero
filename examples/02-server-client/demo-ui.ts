//! ── the two-terminal demo's screen: clear, one label line, the JSON ──
// Shared by server.ts and client.ts (the site's recorder splits frames on the header line). Everything here is the public surface — `cluster.me` is the
// one place a node says where it listens, which directory it met, and which servers it knows (`hosts`);
// the live links are `cluster.snapshot().peers`.

let last = ''
export const render = (label: string, value: unknown) => {
  const text = `fero two-terminal demo — ${label}\n\n${JSON.stringify(value, null, 2)}`
  if (text === last) return                                           //! a tap fires per applied record, and the cluster view refolds on every write outcome (pending → committed), so a redraw can carry the same picture: redraw only when it changed
  last = text
  console.clear()
  console.log(text)
}

//! where am I, and who do I know: the listen the OS chose, the directory, the servers the directory
// lists for this name (`hosts`) — all on cluster.me; `.snapshot()` is the public sync read of any view
type Me = { listen: string; hosts: string[]; rendezvous: false | { addr: string; hosting: boolean; up: boolean } }
export const label = (role: string, resource: { cluster: any }) => {
  const me = resource.cluster.me.snapshot() as Me
  const rz = me.rendezvous === false ? 'no directory' : `directory ${me.rendezvous.addr}${me.rendezvous.hosting ? ' (hosting)' : ''}${me.rendezvous.up ? '' : ' (down)'}`
  return `${role}${me.listen ? ` on ${me.listen}` : ''} — ${rz} — servers ${JSON.stringify(me.hosts)}`
}
