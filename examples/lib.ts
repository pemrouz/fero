//! ── examples/lib — plain Node process plumbing shared by the examples. ZERO fero code. ──
// A reader copies one example folder plus this file and has everything. Nothing here touches fero:
// bounding a run (FERO_EXAMPLE_TICKS), a clean exit on Ctrl-C, a poll, and the child-process helpers
// a check.ts uses to run the terminals its README names and read what they print.

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

//! ticks() — how many ticks a role runs before it destroys itself: FERO_EXAMPLE_TICKS, or forever.
// A check.ts sets it; a terminal never does. The role prints the same lines either way.
export const ticks = (): number => {
  const v = process.env.FERO_EXAMPLE_TICKS
  return v === undefined || v === '' ? Infinity : Number(v)
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

//! logChanges() — a console.log that skips a repeat of the previous line. Taps fire per applied
// record, and one assignment can land more than once (a client's own write shows now and again as its
// committed echo; the cluster view refolds on every write outcome), so a render loop prints only when
// the picture changed.
export const logChanges = (): ((line: string) => void) => {
  let last = ''
  return (line) => { if (line !== last) console.log((last = line)) }
}

//! coalesce — run fn once after the current synchronous batch of records (a microtask), not once per
// record. A tap fires per applied record, and the cluster view sets its fields one record at a time
// (epoch, writable, members…), so a render that reads the whole snapshot INSIDE the tap can see a
// half-updated picture for an instant.
export const coalesce = (fn: () => unknown): (() => void) => {
  let queued = false
  return () => {
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; void fn() })
  }
}

//! until(check, ms) — poll a sync or async predicate every 25 ms. A throw or a rejection counts as
// false; resolves false on timeout. Never hangs, never throws — the caller asserts the boolean.
export const until = async (check: () => unknown, ms = 10_000): Promise<boolean> => {
  const t0 = Date.now()
  for (;;) {
    try { if (await check()) return true } catch {}
    if (Date.now() - t0 > ms) return false
    await sleep(25)
  }
}

//! onExit(fn) — Ctrl-C (SIGINT) or SIGTERM runs fn (destroy the instances), then exits 0. Without
// destroy() a fero process never ends: the shell's timers and sockets are ref'd on purpose.
//! privateDirectory() — a check meets its OWN directory, never the box's. On the default rendezvous the
// roles a check spawns would find whatever is already registered there (your own terminals, say) and
// the proof would be of the wrong cluster. The smoke tier sets FERO_RENDEZVOUS itself; by hand this
// picks a free loopback port. Children inherit it through spawnRole's env spread.
export const privateDirectory = async (): Promise<void> => {
  if (process.env.FERO_RENDEZVOUS !== undefined && process.env.FERO_RENDEZVOUS !== '') return
  const port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const a = s.address() as net.AddressInfo; s.close(() => resolve(a.port)) })
  })
  process.env.FERO_RENDEZVOUS = `127.0.0.1:${port}`
}

export const onExit = (fn: () => unknown): void => {
  let done = false
  const go = async () => {
    if (done) return
    done = true
    try { await fn() } finally { process.exit(0) }
  }
  process.once('SIGINT', go)
  process.once('SIGTERM', go)
}

//! Role — one spawned terminal: its stdout so far, its exit code, and a kill switch.
export interface Role { out: string; exited: Promise<number | null>; kill(signal?: NodeJS.Signals): void; child: ChildProcess }

//! spawnRole(file, args, {env, tag}) — run `node <file> ...args` exactly as a terminal would (no
// flags: Node ≥ 22.18 / 23.6 strips types by itself), capture its stdout, echo every line prefixed
// with the tag, and inherit + extend the environment (the smoke test's private FERO_RENDEZVOUS rides
// through). NOT detached: the child stays in this process group, so a group kill reaches it.
export const spawnRole = (file: string, args: string[] = [], opts: { env?: Record<string, string>; tag?: string } = {}): Role => {
  const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...(opts.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
  const tag = opts.tag ?? file.split('/').pop()
  const role: Role = { out: '', exited: new Promise((r) => child.once('exit', (code) => r(code))), kill: (s = 'SIGTERM') => { child.kill(s) }, child }
  const echo = (stream: NodeJS.ReadableStream, err: boolean) => {
    let buf = ''
    stream.setEncoding('utf8')
    stream.on('data', (d: string) => {
      if (!err) role.out += d
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop()!
      for (const l of lines) (err ? console.error : console.log)(`[${tag}] ${l}`)
    })
  }
  echo(child.stdout!, false)
  echo(child.stderr!, true)
  return role
}

//! story(roles, fn) — run a check's story; whatever happens, every role still running is killed.
export const story = async <T>(roles: Role[], fn: () => Promise<T>): Promise<T> => {
  try { return await fn() }
  finally { for (const r of roles) if (r.child.exitCode === null && r.child.signalCode === null) r.kill('SIGKILL') }
}
