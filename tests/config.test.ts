//! Tier-3 config tier (V4-10): the layer end to end, through REAL children — a real argv, a real
// environment, a real cwd holding a package.json and a fero.opt.js, a real $HOME — composing through the
// public fero() and reporting diag(f).config() + cluster.me. The battery's FERO_CONFIG=off is DELETED
// from every child's environment (else every case would run with the layer off and pass vacuously);
// FERO_RENDEZVOUS=off stays so no child meets a live box directory. One guard pins that the checkout
// itself holds no fero.opt.* (a file at the project root would reach every hand-run example).

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ports } from '#utils'

const ROOT = path.join(import.meta.dirname, '..')
const CHILD = path.join(import.meta.dirname, 'config.child.ts')
const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'fero-config-e2e-'))
//! a project dir: a package.json (the walk's stop) and, when given, a fero.opt.js beside it
const project = (file?: string): string => {
  const d = scratch()
  fs.writeFileSync(path.join(d, 'package.json'), '{ "type": "module" }')
  if (file !== undefined) fs.writeFileSync(path.join(d, 'fero.opt.js'), `export default ${file}`)
  return d
}
const home = (file?: string): string => {
  const d = scratch()
  if (file !== undefined) fs.writeFileSync(path.join(d, 'fero.opt.js'), `export default ${file}`)
  return d
}

interface Line { name: string; config: Record<string, { value: unknown; from: string }>; me: { listen: string; role: string; hosts: string[] }; refused?: string | null }
//! run — spawn the child with the layer ON (FERO_CONFIG deleted), the directory OFF, the given argv,
// extra env, cwd and HOME; resolve with the parsed lines or the ERR message
const run = async (names: string, o: { argv?: string[]; env?: Record<string, string>; cwd?: string; home?: string; call?: Record<string, unknown> } = {}): Promise<{ lines: Line[]; err: string | null; stderr: string }> => {
  const env: Record<string, string | undefined> = { ...process.env, FERO_RENDEZVOUS: 'off', HOME: o.home ?? home() }
  delete env.FERO_CONFIG // the battery's pin: the layer is ON in every child unless a case sets it itself
  Object.assign(env, o.env ?? {})
  if (o.call) env.CHILD_CALL = JSON.stringify(o.call)
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CHILD, names, ...(o.argv ?? [])], { cwd: o.cwd ?? project(), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d })
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d })
  const code = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, 20_000)
    child.once('exit', (c) => { clearTimeout(t); resolve(c) })
  })
  const rows = out.trim().split('\n').filter(Boolean)
  const errLine = rows.find((l) => l.startsWith('ERR '))
  if (errLine !== undefined) return { lines: [], err: errLine.slice(4), stderr }
  assert.equal(code, 0, `child exited ${code}\n${stderr}`)
  return { lines: rows.map((l) => JSON.parse(l) as Line), err: null, stderr }
}

test('the checkout holds no fero.opt.* — a file at the project root would reach every hand-run example', () => {
  for (const ext of ['ts', 'js']) assert.ok(!fs.existsSync(path.join(ROOT, `fero.opt.${ext}`)), `fero.opt.${ext} at the repo root`)
})

test('the lockfile is tracked and pins optcascade — a fresh clone installs exactly what the battery ran', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string }> }
  assert.ok(lock.packages['node_modules/optcascade']?.version, 'optcascade pinned in package-lock.json')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; engines: { node: string } }
  assert.deepEqual(Object.keys(pkg.dependencies), ['optcascade'], 'optcascade is the one dependency')
  assert.equal(pkg.engines.node, '>=22.18')
})

test('README names every config leaf in its Configuration table (the docs drift gate)', async () => {
  const { CONFIG_LEAVES } = await import('../api/config.ts')
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const start = readme.indexOf('\n## Configuration')
  assert.ok(start > 0, 'README has a "## Configuration" section')
  const section = readme.slice(start, readme.indexOf('\n## ', start + 5))
  for (const leaf of CONFIG_LEAVES) assert.ok(section.includes('`' + leaf + '`'), `README's Configuration section names \`${leaf}\``)
  for (const word of ['`FERO_CONFIG`', '`--fero.', '`fero.opt.ts`', 'npm install']) assert.ok(section.includes(word), `README's Configuration section mentions ${word}`)
})

test('a project fero.opt.js sets listen; a flag beats it; provenance names each', async () => {
  const p1 = await ports.free(); const p2 = await ports.free()
  const cwd = project(`{ listen: '127.0.0.1:${p1}' }`)
  const byFile = await run('shop', { cwd, call: { server: true } })
  assert.equal(byFile.err, null, byFile.err ?? '')
  assert.equal(byFile.lines[0].me.listen, `127.0.0.1:${p1}`)
  assert.deepEqual(byFile.lines[0].config.listen, { value: `127.0.0.1:${p1}`, from: 'a fero.opt.ts file (listen)' })
  assert.deepEqual(byFile.lines[0].config.server, { value: true, from: 'the call' })
  const byFlag = await run('shop', { cwd, call: { server: true }, argv: ['--fero.listen', `127.0.0.1:${p2}`] })
  assert.equal(byFlag.err, null, byFlag.err ?? '')
  assert.equal(byFlag.lines[0].me.listen, `127.0.0.1:${p2}`)
  assert.equal(byFlag.lines[0].config.listen.from, '--fero.listen')
})

test('a flag alone makes a server: --fero.dir with no code change; the WAL lands in that dir', async () => {
  const dir = path.join(scratch(), 'state')
  const r = await run('shop', { argv: ['--fero.dir', dir] })
  assert.equal(r.err, null, r.err ?? '')
  assert.equal(r.lines[0].me.role, 'server')
  assert.deepEqual(r.lines[0].config.dir, { value: dir, from: '--fero.dir' })
  assert.ok(fs.existsSync(path.join(dir, 'wal.log')), 'wal.log in the flag\'s dir')
})

test('two resources in one process: the per-resource rung gives each its own dir', async () => {
  const a = path.join(scratch(), 'shop'); const b = path.join(scratch(), 'users')
  const r = await run('shop,users', { env: { FERO_SHOP_DIR: a, FERO_USERS_DIR: b, FERO_HEARTBEAT_MS: '50' } })
  assert.equal(r.err, null, r.err ?? '')
  assert.deepEqual(r.lines.map((l) => [l.name, l.config.dir.value, l.config.dir.from, l.config['heartbeat.ms'].from]), [['shop', a, 'FERO_SHOP_DIR', 'FERO_HEARTBEAT_MS'], ['users', b, 'FERO_USERS_DIR', 'FERO_HEARTBEAT_MS']])
  assert.ok(fs.existsSync(path.join(a, 'wal.log')) && fs.existsSync(path.join(b, 'wal.log')))
})

test('a $HOME fero.opt.js reaches a process; the project file beats it', async () => {
  const h = home("{ heartbeat: { ms: 250 }, redial: { ms: 40 } }")
  const alone = await run('shop', { home: h, call: { server: true } })
  assert.equal(alone.err, null, alone.err ?? '')
  assert.deepEqual(alone.lines[0].config['heartbeat.ms'], { value: 250, from: 'a fero.opt.ts file (heartbeat.ms)' })
  const over = await run('shop', { home: h, cwd: project("{ heartbeat: { ms: 100 } }"), call: { server: true } })
  assert.equal(over.err, null, over.err ?? '')
  assert.equal(over.lines[0].config['heartbeat.ms'].value, 100)
  assert.equal(over.lines[0].config['redial.ms'].value, 40)
})

test('redial.tries (the tune table\'s one config key): the default shows as 10, a variable and a file set it, a fraction is refused naming its source', async () => {
  const dflt = await run('shop', { call: { server: true } })
  assert.equal(dflt.err, null, dflt.err ?? '')
  assert.deepEqual(dflt.lines[0].config['redial.tries'], { value: 10, from: 'the default' })
  const env = await run('shop', { env: { FERO_REDIAL_TRIES: '3' }, call: { server: true } })
  assert.equal(env.err, null, env.err ?? '')
  assert.deepEqual(env.lines[0].config['redial.tries'], { value: 3, from: 'FERO_REDIAL_TRIES' })
  const file = await run('shop', { cwd: project('{ redial: { ms: 40, tries: 2 } }'), call: { server: true } })
  assert.equal(file.err, null, file.err ?? '')
  assert.deepEqual([file.lines[0].config['redial.tries'], file.lines[0].config['redial.ms'].value], [{ value: 2, from: 'a fero.opt.ts file (redial.tries)' }, 40])
  assert.match((await run('shop', { argv: ['--fero.redial.tries', '1.5'], call: { server: true } })).err ?? '', /redial\.tries must be an integer ≥ 0 \(from --fero\.redial\.tries\)/)
})

test('refusals name their source: the legacy FERO_RENDEZVOUS text, a non-number, a stray old spelling, a typo', async () => {
  assert.match((await run('shop', { env: { FERO_RENDEZVOUS: 'garbage' }, call: { server: true } })).err ?? '', /FERO_RENDEZVOUS='garbage' is not a 'host:port' address \(or 'off'\)/)
  assert.match((await run('shop', { env: { FERO_HEARTBEAT_MS: 'abc' }, call: { server: true } })).err ?? '', /heartbeat\.ms must be a finite number of milliseconds ≥ 0 \(0 = heartbeats off\) \(from FERO_HEARTBEAT_MS\)/)
  assert.match((await run('shop', { env: { FERO_HEARTBEATMS: '5' }, call: { server: true } })).err ?? '', /'heartbeatms' is spelled heartbeat: \{ ms \} since V4-10/)
  assert.match((await run('shop', { argv: ['--fero.replica', '2'], call: { server: true } })).err ?? '', /unknown option 'replica' from --fero\.replica — did you mean --fero\.replicas/)
  assert.match((await run('shop', { argv: ['--fero.listen', ':5'], call: { server: true } })).err ?? '', /listen must be a 'host:port' string .* \(from --fero\.listen\)/)
})

test('server: false pins the client role: a server marker or server: true from a flag is refused naming both sources', async () => {
  const r = await run('shop', { argv: ['--fero.dir', path.join(scratch(), 'x')], call: { server: false, hosts: ['127.0.0.1:1'] } })
  assert.match(r.err ?? '', /server: false pins the client role, but 'dir' makes a server \(from --fero\.dir\) — drop one/)
  const flip = await run('shop', { argv: ['--fero.server'], call: { server: false, hosts: ['127.0.0.1:1'] } })
  assert.match(flip.err ?? '', /server: true \(from --fero\.server\) but server: false pins the client role — drop one/)
  //! the pin holds and the process stays a client
  const held = await run('shop', { call: { server: false, hosts: ['127.0.0.1:1'] } })
  assert.equal(held.err, null, held.err ?? '')
  assert.equal(held.lines[0].me.role, 'client')
  assert.deepEqual(held.lines[0].config.server, { value: false, from: 'the call' })
  //! the door shows the effective defaults too, and the seed as its row keys
  const dflt = await run('shop', { call: { data: { widgets: { stock: 1 } } } })
  assert.equal(dflt.err, null, dflt.err ?? '')
  assert.deepEqual(dflt.lines[0].config['heartbeat.ms'], { value: 500, from: 'the default' })
  assert.deepEqual(dflt.lines[0].config['journal.cap'], { value: 4096, from: 'the default' })
  assert.deepEqual(dflt.lines[0].config.data, { value: ['widgets'], from: 'the call' })
  assert.deepEqual(dflt.lines[0].config.rendezvous, { value: false, from: 'FERO_RENDEZVOUS' })
})

test('FERO_CONFIG=off in a real process: flags and files are not read', async () => {
  const env: Record<string, string> = { FERO_CONFIG: 'off' }
  const r = await run('shop', { env, argv: ['--fero.dir', path.join(scratch(), 'x')], cwd: project("{ server: true }") })
  //! with the layer off, nothing made this a server and nothing gave it hosts: the bare client's refusal
  assert.match(r.err ?? '', /a client needs something to dial/)
})

test('validation: and its old spelling seams.validation both guard writes in a real process; the old one prints its note to stderr once, however many resources', async () => {
  const top = await run('shop,users', { env: { CHILD_VALIDATION: 'top' }, call: { listen: false } })
  assert.equal(top.err, null, top.err ?? '')
  assert.deepEqual(top.lines.map((l) => [l.name, l.refused, l.config.validation]), [['shop', 'no bad rows', { value: '[function]', from: 'the call' }], ['users', 'no bad rows', { value: '[function]', from: 'the call' }]])
  assert.doesNotMatch(top.stderr, /seams/, 'the new spelling prints nothing')
  const old = await run('shop,users', { env: { CHILD_VALIDATION: 'seams' }, call: { listen: false } })
  assert.equal(old.err, null, old.err ?? '')
  assert.deepEqual(old.lines.map((l) => [l.name, l.refused, l.config.validation?.from]), [['shop', 'no bad rows', 'the call'], ['users', 'no bad rows', 'the call']])
  const notes = old.stderr.split('\n').filter((l) => l.includes('seams: { validation } is now spelled validation:'))
  assert.equal(notes.length, 1, `one note for two resources:\n${old.stderr}`)
  assert.equal(notes[0], "fero('shop'): seams: { validation } is now spelled validation: — the old spelling still works in this release and goes in the next")
})
