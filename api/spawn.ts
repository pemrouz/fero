import { spawn as run, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { track, untrack } from './signals.ts'
import type { Spawned, SpawnOpts } from './types.ts'

//! ── fero.spawn (V4-9): `node <file> …` as a separate process — the reader's other terminal, from code ──
// The handle is what a script or a check needs: the pid, what the process printed, and a stop() that
// IS the reader's Ctrl-C (SIGINT: a fero process leaves by ballot and exits 0, V4-8) but gives up after
// GRACE ms (SIGKILL, null), so a broken clean stop FAILS the caller instead of hanging it. A child is
// tracked like a live instance: the parent's own Ctrl-C stops it and waits. A parent that dies on an
// error — a thrown assertion — takes its children with it on 'exit' (SIGKILL: the loop is gone, nothing
// is left to wait with); a SIGKILLed parent runs nothing and orphans them, which is why the smoke tier
// kills its whole process group itself. The file resolves as the terminal would (against the cwd);
// stdout and stderr are echoed prefixed `[name pid]` so two copies of one file tell apart. stdin is
// CLOSED unless asked for: `{ stdin: 'pipe' }` keeps it open and `write(line)` types a line into it (the
// reader's keystrokes and Enter), so a check can drive a role's readline the way the README's terminal does.
const GRACE = 5000
const children = new Set<ChildProcess>()
let hooked = false

export const spawn = (file: string, args: string[] = [], opts: SpawnOpts = {}): Spawned => {
  if (!hooked) { hooked = true; process.on('exit', () => { for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL') }) }
  const child = run(process.execPath, [file, ...args], { stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'] })
  children.add(child)
  const tag = `[${path.basename(file, path.extname(file))} ${child.pid ?? '?'}]`
  // a late write (the child ended between a check's look and its write) surfaces as EPIPE on the pipe: said, not thrown at random
  child.stdin?.on('error', (e) => console.error(`${tag} stdin ${e.message}`))
  // 'close', not 'exit': the pipes have drained, so `out` is complete once `exited` resolves
  const exited = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code))
    child.once('error', (e) => { console.error(`${tag} ${e.message}`); resolve(null) })
  })
  const handle: Spawned = {
    pid: child.pid!,
    out: '',
    exited,
    child,
    stop: async () => {
      child.kill('SIGINT')
      const code = await Promise.race([exited, new Promise<'hung'>((r) => setTimeout(r, GRACE, 'hung').unref())])
      if (code !== 'hung') return code
      child.kill('SIGKILL')
      return exited
    },
    write: (line) => {
      if (!child.stdin) throw new Error(`fero.spawn: ${tag} has no stdin — spawn it with { stdin: 'pipe' } to type into it`)
      if (child.stdin.destroyed) throw new Error(`fero.spawn: ${tag} has exited — nothing reads its stdin`)
      child.stdin.write(`${line}\n`)
    },
  }
  const entry = { destroy: handle.stop }
  track(entry)
  void exited.then(() => { children.delete(child); untrack(entry) })
  for (const [stream, print] of [[child.stdout, console.log], [child.stderr, console.error]] as const) {
    if (!stream) continue   // a spawn that failed before its pipes existed (EMFILE): 'error' tells the story
    let buf = ''
    stream.setEncoding('utf8')
      .on('data', (d: string) => {
        if (print === console.log) handle.out += d
        const lines = (buf + d).split('\n')
        buf = lines.pop()!
        for (const l of lines) print(`${tag} ${l}`)
      })
      .on('end', () => { if (buf) print(`${tag} ${buf}`) })
  }
  return handle
}
