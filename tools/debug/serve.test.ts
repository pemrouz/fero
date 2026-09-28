//! ── tools/debug/serve.test — the debug server as a PROCESS: the banner, the not-yet-there capture, the clean stop ──
// Drives tools/debug/serve.ts the way a reader does — `node serve.ts <file> --port N` in a child on a free
// port — and pins what the READMEs paste (the listen banner) and what a driver relies on. The page suites
// (viewer.dom / scenarios.dom) prove what the pages paint; THIS file proves the process around them.

import { test } from 'node:test'
import assert from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Sim } from '../../sim/exec.ts'
import { cluster, writes } from '../../sim/harness.ts'
import { captureSim } from './capture.ts'
import { ports } from '#utils'

const SERVE = path.join(import.meta.dirname, 'serve.ts')
const ROOT = path.join(import.meta.dirname, '..', '..')

//! a small real capture to serve (a formed 2-node sim with a few writes — never a hand-authored file)
const smallCapture = () => {
  const sim = new Sim(3)
  const pair = cluster(sim, 2)
  writes(sim, pair, 4, 20)
  sim.run()
  return JSON.stringify(captureSim(sim))
}

//! start the server on a free port over `file`; resolves once the listen banner printed (the reader's cue)
const serve = async (file: string) => {
  const port = await ports.free()
  const child: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', SERVE, file, '--port', String(port)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout!.setEncoding('utf8').on('data', (d: string) => { out += d })
  child.stderr!.setEncoding('utf8').on('data', (d: string) => { out += d })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })))
  const t0 = Date.now()
  while (!/^.* → http:\/\/localhost:\d+\/ .*$/m.test(out)) {
    assert.ok(Date.now() - t0 < 20_000, `the server never printed its banner:\n${out}`)
    await new Promise((r) => setTimeout(r, 50))
  }
  const banner = out.split('\n').find((l) => l.includes('→ http://localhost:'))!
  return { child, port, banner, out: () => out, exited, kill: () => { try { child.kill('SIGKILL') } catch {} } }
}

test('the listen banner says fero v4 — the line three READMEs paste', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fero-serve-'))
  const file = path.join(dir, 'x.capture.json')
  writeFileSync(file, smallCapture())
  const s = await serve(file)
  try {
    assert.equal(s.banner, `fero v4 → http://localhost:${s.port}/  (capture: ${file})`)
    assert.ok(!s.out().includes('v3'), `nothing the server prints says v3:\n${s.out()}`)
  } finally { s.kill(); await s.exited; rmSync(dir, { recursive: true, force: true }) }
})

test('a capture file that is not there yet answers 404 with a typed body, never 500 — the viewer keys on it and waits (ISSUES I-39)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fero-serve-'))
  const file = path.join(dir, 'later.capture.json')            // does not exist when the server starts
  const s = await serve(file)
  try {
    const r = await fetch(`http://localhost:${s.port}/capture.json`)
    assert.equal(r.status, 404, 'a file that is not there yet is a 404, not a server error')
    assert.match(await r.text(), /^no capture yet: .*later\.capture\.json/, 'the body names the file and the wait')
    const home = await fetch(`http://localhost:${s.port}/`)
    assert.ok((await home.text()).includes('<title>fero — debug'), 'the debugger page still serves meanwhile')
    writeFileSync(file, smallCapture())                           // the role writes it a moment later
    const r2 = await fetch(`http://localhost:${s.port}/capture.json`)
    assert.equal(r2.status, 200)
    assert.equal((await r2.json()).kind, 'sim', 'the same URL now serves the capture — no restart')
  } finally { s.kill(); await s.exited; rmSync(dir, { recursive: true, force: true }) }
})
