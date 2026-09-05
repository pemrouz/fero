//! ── the two-terminal demo's screen: clear, one label line, the JSON ──
// Shared by server.ts and client.ts. Everything here is the public surface — `cluster.me` is the
// one place a node says where it listens, which directory it met, and which peers it knows.

export const render = (label: string, value: unknown) => {
  console.clear()
  console.log(`fero two-terminal demo — ${label}\n`)
  console.log(JSON.stringify(value, null, 2))
}

//! where am I, and who do I know: the listen the OS chose, the directory, the discovered peers —
// all on cluster.me; `.snapshot()` is the public sync read of any view
type Me = { listen: string; hosts: string[]; rendezvous: false | { addr: string; hosting: boolean; up: boolean } }
export const label = (role: string, f: { cluster: any }) => {
  const me = f.cluster.me.snapshot() as Me
  const rz = me.rendezvous === false ? 'no directory' : `directory ${me.rendezvous.addr}${me.rendezvous.hosting ? ' (hosting)' : ''}${me.rendezvous.up ? '' : ' (down)'}`
  return `${role}${me.listen ? ` on ${me.listen}` : ''} — ${rz} — peers ${JSON.stringify(me.hosts)}`
}
