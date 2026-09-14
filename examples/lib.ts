// examples/lib — the plain-Node plumbing a check.ts needs: run the terminals a README names, read what
// they print, stop them, and meet a private directory. Zero fero code. A role file needs nothing from here:
// Ctrl-C is a clean stop inside fero, and a tap fires once per change.

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Poll a predicate every 25 ms until it is truthy (→ true) or `ms` pass (→ false). A throw counts as false.
export const until = async (check: () => unknown, ms = 10_000): Promise<boolean> => {
  for (const t0 = Date.now(); ; await sleep(25)) {
    try { if (await check()) return true } catch {}
    if (Date.now() - t0 > ms) return false
  }
}

// A check meets its OWN directory (a free port), never the box's 127.0.0.1:3376 — so `node check.ts`
// never meets the reader's own terminals. The smoke tier sets FERO_RENDEZVOUS itself; roles inherit it.
export const privateDirectory = async (): Promise<void> => {
  if (process.env.FERO_RENDEZVOUS) return
  const port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const a = s.address() as net.AddressInfo; s.close(() => resolve(a.port)) })
  })
  process.env.FERO_RENDEZVOUS = `127.0.0.1:${port}`
}

// One spawned terminal: `node <file>` exactly as a reader runs it. `out` is its stdout so far, `pid` the
// key its rows are written under, `stop()` sends Ctrl-C (SIGINT) and resolves with the exit code — or
// null after 5 s, when it is SIGKILLed instead, so a broken clean stop FAILS a check instead of hanging it.
// Whatever happens to the check (a failed assertion, Ctrl-C), every role still running is stopped.
export interface Role { pid: number; out: string; exited: Promise<number | null>; stop(signal?: NodeJS.Signals): Promise<number | null>; child: ChildProcess }
const children: ChildProcess[] = []
process.on('exit', () => { for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL') })
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { for (const c of children) c.kill('SIGTERM'); setTimeout(() => process.exit(1), 500) })

export const spawnRole = (file: string, tag: string): Role => {
  const child = spawn(process.execPath, [file], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)))
  const role: Role = {
    pid: child.pid!, out: '', exited, child,
    stop: async (signal = 'SIGINT') => {
      child.kill(signal)
      const code = await Promise.race([exited, sleep(5000).then(() => 'hung' as const)])
      if (code !== 'hung') return code
      child.kill('SIGKILL')
      return null
    },
  }
  for (const [stream, err] of [[child.stdout!, false], [child.stderr!, true]] as const) {
    let buf = ''
    stream.setEncoding('utf8').on('data', (d: string) => {
      if (!err) role.out += d
      const lines = (buf + d).split('\n')
      buf = lines.pop()!
      for (const l of lines) (err ? console.error : console.log)(`[${tag}] ${l}`)
    })
  }
  return role
}
