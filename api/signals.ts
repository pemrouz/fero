//! ── the clean stop on Ctrl-C (V4-8) ──
// SIGINT or SIGTERM: everything live stops — an instance destroy()s (the graceful leave, then teardown)
// and a spawned child is sent SIGINT — its own clean stop — and waited for (V4-9) — and, when nothing else in the
// process listens for that signal, the process exits 0. Without this a Ctrl-C is a CRASH as the cluster
// sees it (no leave: a two-member cluster wedges, DECISIONS V4-6), and a process that never calls
// destroy() never ends (the shell's timers and sockets are ref'd on purpose). One listener per signal
// for the whole module, installed by the first live thing and removed by the last, so a process with
// nothing live keeps Node's default. `signals: false` keeps an instance out.
export interface Live { destroy(): Promise<unknown> }

const live = new Set<Live>()
const SIGNALS = ['SIGINT', 'SIGTERM'] as const
let listening = false
const onSignal = (sig: NodeJS.Signals): void => {
  const others = process.listenerCount(sig) - 1
  void Promise.allSettled([...live].map((f) => f.destroy())).then(() => { if (others === 0) process.exit(0) })
}
export const track = (f: Live): void => {
  live.add(f)
  if (!listening) { listening = true; for (const s of SIGNALS) process.on(s, onSignal) }
}
export const untrack = (f: Live): void => {
  if (!live.delete(f) || live.size > 0) return
  listening = false
  for (const s of SIGNALS) process.off(s, onSignal)
}
