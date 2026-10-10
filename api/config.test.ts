//! api/config unit suite: the six layers with INJECTED sources — no real argv, env, cwd or $HOME is ever
// read here, so the suite is deterministic on any box. Every experiment finding from the V4-10 study is a
// pinned case: the nested spelling survives every layer, unknown keys throw naming their source, the
// old camelCase keys point at the new spelling, the string coercions (CSV hosts, off/false/0), the
// per-resource rung, the call-only keys, FERO_CONFIG=off making zero optcascade calls, and the memoized
// file walk. The file layer uses scratch directories built per test.

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig, nameKey, CONFIG_LEAVES } from './config.ts'

//! nothing but the call: an empty argv and env, and directories that hold no file
const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'fero-config-'))
const none = () => ({ argv: [] as string[], env: {} as Record<string, string>, cwd: scratch(), home: scratch() })
const r = (name: string, call: Record<string, unknown>, s: Partial<ReturnType<typeof none>> = {}) => resolveConfig(name, call as never, { ...none(), ...s })
const cfg = (...a: Parameters<typeof r>) => r(...a).config as Record<string, unknown>

test('the call alone folds through unchanged, nested groups included', () => {
  const rule = () => true as const
  const { config, from } = r('shop', { server: true, heartbeat: { ms: 250 }, hosts: ['a:1'], validation: rule })
  assert.deepEqual(config, { server: true, heartbeat: { ms: 250 }, hosts: ['a:1'], validation: rule })
  assert.equal(from('heartbeat.ms'), 'the call')
  assert.equal(from('redial.ms'), 'the default')
})

test('validation: is a top-level key; seams.validation is its old spelling for one release — folded into it, with a note once per process', () => {
  const rule = () => true as const
  const notes: string[] = []
  const note = (line: string) => { notes.push(line) }
  //! the new spelling: no note
  assert.deepEqual(r('shop', { validation: rule }, { note } as never).config, { validation: rule })
  assert.deepEqual(notes, [])
  //! the old spelling lands on the SAME key (the composer reads one), named the call, and the note says what to write
  const old = r('shop', { seams: { validation: rule } }, { note } as never)
  assert.deepEqual(old.config, { validation: rule })
  assert.equal(old.from('validation'), 'the call')
  assert.equal(notes.length, 1)
  assert.match(notes[0], /^fero\('shop'\): seams: \{ validation \} is now spelled validation: — the old spelling still works in this release and goes in the next\n$/)
  //! once per sink (the real process has one, stderr): a second resource, a second call — no second note
  r('users', { seams: { validation: rule } }, { note } as never)
  r('shop', { seams: { validation: rule } }, { note } as never)
  assert.equal(notes.length, 1, 'the note prints once')
  //! both at once is one key set twice: refused, never a silent pick
  assert.throws(() => r('shop', { validation: rule, seams: { validation: rule } }, { note } as never), /fero\('shop'\): validation and seams\.validation are one key, set twice — keep validation and drop seams/)
  //! a function: the call only, under either spelling
  assert.throws(() => r('r', {}, { argv: ['--fero.validation', '1'] }), /'validation' cannot come from --fero\.validation — it is set in the call only \(a function\)/)
  assert.throws(() => r('r', {}, { env: { FERO_VALIDATION: 'x' } }), /'validation' cannot come from FERO_VALIDATION — it is set in the call only/)
  assert.equal(nameKey('validation'), null, 'a declared key is never a resource rung')
})

test('diag.allow: from the call, a variable (FERO_DIAG_ALLOW_<NAME>) or a file — never a flag; the refusal never echoes the token', () => {
  //! the call and a variable; envdeep lowercases the name and keeps the token as written
  assert.deepEqual(cfg('shop', { diag: { allow: { ops: 'Tok-1' } } }), { diag: { allow: { ops: 'Tok-1' } } })
  const env = r('shop', {}, { env: { FERO_DIAG_ALLOW_OPS: 'Tok-2' } })
  assert.deepEqual(env.config, { diag: { allow: { ops: 'Tok-2' } } })
  assert.equal(env.from('diag.allow'), 'FERO_DIAG_ALLOW')
  //! the per-resource rung, like every key
  assert.deepEqual(cfg('shop', {}, { env: { FERO_SHOP_DIAG_ALLOW_OPS: 'Tok-3', FERO_DIAG_ALLOW_OPS: 'other' } }), { diag: { allow: { ops: 'Tok-3' } } })
  //! a file
  const home = scratch()
  fs.writeFileSync(path.join(home, 'fero.opt.js'), "export default { diag: { allow: { alice: 'Tok-4' } } }")
  assert.deepEqual(cfg('shop', {}, { home }), { diag: { allow: { alice: 'Tok-4' } } })
  //! the viewer's own variable is still not config, beside a real allow
  assert.deepEqual(cfg('shop', {}, { env: { FERO_DIAG_TOKEN: 'viewer', FERO_DIAG_ALLOW_OPS: 'Tok-5' } }), { diag: { allow: { ops: 'Tok-5' } } })
  //! never a flag, under any spelling, and the message carries the name but never the token
  for (const argv of [['--fero.diag.allow.ops', 'Sekrit-9'], ['--fero.shop.diag.allow.ops', 'Sekrit-9'], ['--fero.diag', 'Sekrit-9']]) {
    assert.throws(() => r('shop', {}, { argv }), (e: Error) => {
      assert.match(e.message, /a diag token cannot come from a launch flag \(--fero\.(shop\.)?diag(\.allow(\.ops)?)?\) — every user on this box can read a command line; set FERO_(SHOP_)?DIAG_ALLOW_(OPS|<NAME>)=<token>, or diag: \{ allow: \{ (ops|<name>): … \} \} in the call or a fero\.opt\.ts file/)
      assert.ok(!e.message.includes('Sekrit-9'), `the secret is not in the message: ${e.message}`)
      return true
    }, argv.join(' '))
  }
  //! a variable can only carry text: a token envdeep reads as a number or a boolean lost its text, and an
  // `_` in the name nests it — each refused in words that say what was typed, naming the variable, never the value
  const lost = /the diag token in FERO_DIAG_ALLOW_OPS reads as a number or a boolean, so its text is lost \(a leading zero, 1e5, true\) — give it a letter/
  for (const tok of ['0123', '12.5', '2e7', 'Infinity', 'false'])
    assert.throws(() => r('shop', {}, { env: { FERO_DIAG_ALLOW_OPS: tok } }), (e: Error) => lost.test(e.message) && !e.message.includes(tok), tok)
  assert.throws(() => r('shop', {}, { env: { FERO_DIAG_ALLOW_OPS: 'true' } }), lost)
  assert.throws(() => r('shop', {}, { env: { FERO_DIAG_ALLOW_OPS_TEAM: 'Tok-6' } }), (e: Error) => /FERO_DIAG_ALLOW_OPS_TEAM is not a diag name — a name in a variable is one word of letters and digits \(an _ nests it\); set FERO_DIAG_ALLOW_OPSTEAM=<token>, or diag: \{ allow: \{ ops_team: … \} \} in the call or a fero\.opt\.ts file/.test(e.message) && !e.message.includes('Tok-6'))
  assert.deepEqual(cfg('shop', {}, { env: { FERO_DIAG_ALLOW_OPS2: 'Tok-7' } }), { diag: { allow: { ops2: 'Tok-7' } } }, 'digits in a name are fine')
  //! a file is typed: a wrong shape there is plainly wrong
  const home2 = scratch()
  fs.writeFileSync(path.join(home2, 'fero.opt.js'), 'export default { diag: { allow: { ops: 123 } } }')
  assert.throws(() => r('shop', {}, { home: home2 }), /diag\.allow\.ops must be a token string \(from a fero\.opt\.ts file \(diag\.allow\)\)/)
  //! an empty token is unset, like an empty value anywhere
  assert.deepEqual(cfg('shop', {}, { env: { FERO_DIAG_ALLOW_OPS: '' } }), {})
  //! a typo inside the group gets the leaf as its hint
  assert.throws(() => r('shop', { diag: { alow: {} } }), /unknown option 'diag\.alow' from the call — did you mean diag: \{ allow: … \}/)
  assert.equal(nameKey('diag'), null, 'a declared group is never a resource rung')
})

test('secret (DESIGN-DOOR §5): the call, FERO_SECRET, FERO_SHOP_SECRET over it, a file — never a flag; a number, a boolean or a short value is refused without echoing it; \'\' is unset, off is false; the layer-off note once per process', () => {
  const S = 'unit-test-secret-ALPHA-01'
  //! the call folds through as written (the composer checks its shape); false is the open door on purpose
  assert.deepEqual(cfg('shop', { secret: S }), { secret: S })
  assert.deepEqual(cfg('shop', { secret: false }), { secret: false })
  //! the environment, and the per-resource rung over it
  const env = r('shop', {}, { env: { FERO_SECRET: S } })
  assert.deepEqual(env.config, { secret: S })
  assert.equal(env.from('secret'), 'FERO_SECRET')
  const scoped = r('shop', {}, { env: { FERO_SECRET: S, FERO_SHOP_SECRET: `${S}-shop` } })
  assert.equal(scoped.config.secret, `${S}-shop`)
  assert.equal(scoped.from('secret'), 'FERO_SHOP_SECRET')
  assert.equal(cfg('users', {}, { env: { FERO_SECRET: S, FERO_SHOP_SECRET: `${S}-shop` } }).secret, S, 'another resource reads the global rung')
  //! a $HOME file
  const home = scratch()
  fs.writeFileSync(path.join(home, 'fero.opt.js'), `export default { secret: '${S}-file' }`)
  const file = r('shop', {}, { home })
  assert.equal(file.config.secret, `${S}-file`)
  assert.equal(file.from('secret'), 'a fero.opt.ts file (secret)')
  //! never a flag, under either rung: the refusal names the flag and the three carriers, never the value
  for (const argv of [['--fero.secret', S], ['--fero.shop.secret', S], [`--fero.secret=${S}`]])
    assert.throws(() => r('shop', {}, { argv }), (e: Error) => {
      assert.match(e.message, /^fero\('shop'\): 'secret' cannot come from --fero\.(shop\.)?secret — it is set in the call, the environment or a fero\.opt\.ts file only \(a secret never rides argv: ps, \/proc\/<pid>\/cmdline and shell history show every flag\)$/)
      assert.ok(!e.message.includes(S), `the secret is not in the message: ${e.message}`)
      return true
    }, argv.join(' '))
  //! the shape rule for the text layers: envdeep turns an all-digit or boolean-looking value into a number or a
  // boolean (its text is lost), and a short value is too weak — one refusal, with the hint, never the value
  const hint = /^fero\('shop'\): secret must be text of at least 16 characters \(from FERO_SECRET\) — a value that is all digits is read as a number; openssl rand -base64 24 prints a good one$/
  for (const v of ['1234567890123456', 'true', 'fifteen-chars!!', '12.5e3', 'Infinity', 'short-one'])
    assert.throws(() => r('shop', {}, { env: { FERO_SECRET: v } }), (e: Error) => hint.test(e.message) && !e.message.includes(v), v)
  //! a file is typed, and gets the same words naming the file
  const bad = scratch()
  fs.writeFileSync(path.join(bad, 'fero.opt.js'), 'export default { secret: 12345678901234567890 }')
  assert.throws(() => r('shop', {}, { home: bad }), /secret must be text of at least 16 characters \(from a fero\.opt\.ts file \(secret\)\)/)
  //! '' is unset (the next rung answers); the OFF set is false — open on purpose; a value is trimmed
  assert.deepEqual(cfg('shop', {}, { env: { FERO_SECRET: '' } }), {})
  assert.equal(cfg('shop', { secret: S }, { env: { FERO_SHOP_SECRET: '' } }).secret, S)
  for (const off of ['off', 'false', '0', ' off ']) assert.equal(cfg('shop', {}, { env: { FERO_SECRET: off } }).secret, false, off)
  assert.equal(cfg('shop', {}, { env: { FERO_SECRET: ` ${S} ` } }).secret, S, 'trimmed')
  //! FERO_CONFIG=off ignores the variable like every other, and says so ONCE per process (per sink), naming it;
  // nothing is said for an empty or absent one
  const notes: string[] = []
  const note = (line: string) => { notes.push(line) }
  assert.deepEqual(r('shop', {}, { env: { FERO_CONFIG: 'off', FERO_SECRET: S }, note } as never).config, {})
  r('users', {}, { env: { FERO_CONFIG: 'off', FERO_SECRET: S }, note } as never)
  assert.deepEqual(notes, ['FERO_CONFIG=off: FERO_SECRET is ignored, this process runs open\n'])
  r('shop', {}, { env: { FERO_CONFIG: 'off', FERO_SHOP_SECRET: S }, note } as never)
  assert.deepEqual(notes[1], 'FERO_CONFIG=off: FERO_SHOP_SECRET is ignored, this process runs open\n')
  assert.ok(!notes.join('').includes(S), 'the note never carries the value')
  const quiet: string[] = []
  r('shop', {}, { env: { FERO_CONFIG: 'off', FERO_SECRET: ' ' }, note: (l: string) => { quiet.push(l) } } as never)
  r('shop', {}, { env: { FERO_CONFIG: 'off' }, note: (l: string) => { quiet.push(l) } } as never)
  assert.deepEqual(quiet, [])
  assert.equal(nameKey('secret'), null, 'a declared key is never a resource rung')
})

test('secret.client (DESIGN-DOOR §15): the call, FERO_SECRET_CLIENT, FERO_SHOP_SECRET_CLIENT over it, a file — never a flag; a number, a boolean or a short value refused without echoing it; trimmed, \'\' unset; secret and secret.client together refused naming both sources, from any two layers; the same-rung env pair refused before envdeep eats the secret, and an EMPTY FERO_SECRET_CLIENT= does not eat it; the layer-off note names it', () => {
  const K = 'unit-test-client-key-KILO-11-43chars-long-xx'
  const S = 'unit-test-secret-ALPHA-01'
  //! the call folds through as the nested object (the composer checks its shape)
  assert.deepEqual(cfg('shop', { secret: { client: K } }), { secret: { client: K } })
  //! the environment, and the per-resource rung over it
  const env = r('shop', {}, { env: { FERO_SECRET_CLIENT: K } })
  assert.deepEqual(env.config, { secret: { client: K } })
  assert.equal(env.from('secret.client'), 'FERO_SECRET_CLIENT')
  const scoped = r('shop', {}, { env: { FERO_SECRET_CLIENT: K, FERO_SHOP_SECRET_CLIENT: `${K}-shop` } })
  assert.deepEqual(scoped.config, { secret: { client: `${K}-shop` } })
  assert.equal(scoped.from('secret.client'), 'FERO_SHOP_SECRET_CLIENT')
  //! a $HOME file
  const home = scratch()
  fs.writeFileSync(path.join(home, 'fero.opt.js'), `export default { secret: { client: '${K}-file' } }`)
  const file = r('shop', {}, { home })
  assert.deepEqual(file.config, { secret: { client: `${K}-file` } })
  assert.equal(file.from('secret.client'), 'a fero.opt.ts file (secret.client)')
  //! never a flag, under either rung: the refusal names the flag and the three carriers, never the value
  for (const argv of [['--fero.secret.client', K], ['--fero.shop.secret.client', K], [`--fero.secret.client=${K}`]])
    assert.throws(() => r('shop', {}, { argv }), (e: Error) => {
      assert.match(e.message, /^fero\('shop'\): 'secret\.client' cannot come from --fero\.(shop\.)?secret\.client — it is set in the call, the environment or a fero\.opt\.ts file only \(a secret never rides argv: ps, \/proc\/<pid>\/cmdline and shell history show every flag\)$/)
      assert.ok(!e.message.includes(K), `the key is not in the message: ${e.message}`)
      return true
    }, argv.join(' '))
  //! both flags, the secret first: minimist cannot nest `.client` under a string and throws a TypeError that
  // QUOTES the first flag's value — the clash is named from the flag NAMES alone (the V4-32 review), so neither
  // value reaches the message; the fix for either is the same refusal the flag gets alone
  for (const argv of [['--fero.secret', S, '--fero.secret.client', K], [`--fero.secret=${S}`, `--fero.secret.client=${K}`], ['--fero.shop.secret', S, '--fero.shop.secret.client', K]])
    assert.throws(() => r('shop', {}, { argv }), (e: Error) => {
      assert.match(e.message, /^fero\('shop'\): could not read the launch flags — --fero\.(shop\.)?secret and --fero\.(shop\.)?secret\.client clash: a key is a value or a group, never both — set one of them$/)
      assert.ok(!e.message.includes(S) && !e.message.includes(K), `no value in the message: ${e.message}`)
      return true
    }, argv.join(' '))
  //! the shape rule for the text layers: one refusal naming fero.clientKey, never the value; no off word
  const hint = /^fero\('shop'\): secret\.client must be the client key, text of at least 16 characters \(from FERO_SECRET_CLIENT\) — fero\.clientKey\(secret\) prints it from the cluster's secret$/
  for (const v of ['1234567890123456', 'true', 'fifteen-chars!!', 'off', 'false', '0', 'short-one'])
    assert.throws(() => r('shop', {}, { env: { FERO_SECRET_CLIENT: v } }), (e: Error) => hint.test(e.message) && !e.message.includes(v), v)
  const bad = scratch()
  fs.writeFileSync(path.join(bad, 'fero.opt.js'), 'export default { secret: { client: 12345678901234567890 } }')
  assert.throws(() => r('shop', {}, { home: bad }), /secret\.client must be the client key, text of at least 16 characters \(from a fero\.opt\.ts file \(secret\.client\)\)/)
  //! '' is unset (the next rung answers); a value is trimmed
  assert.deepEqual(cfg('shop', {}, { env: { FERO_SECRET_CLIENT: '' } }), {})
  assert.deepEqual(cfg('shop', { secret: { client: K } }, { env: { FERO_SHOP_SECRET_CLIENT: '' } }), { secret: { client: K } })
  assert.deepEqual(cfg('shop', {}, { env: { FERO_SECRET_CLIENT: ` ${K} ` } }), { secret: { client: K } }, 'trimmed')
  //! a typo under the group points at the one leaf; a dotted spelling is refused like every nested key
  assert.throws(() => r('shop', { secret: { clint: K } }), /unknown option 'secret\.clint' from the call — did you mean secret: \{ client: … \}/)
  assert.throws(() => r('shop', {}, { env: { FERO_SECRET_CLINT: K } }), /unknown option 'secret\.clint' from FERO_SECRET_CLINT — did you mean FERO_SECRET_CLIENT/)
  assert.throws(() => r('shop', { 'secret.client': K } as never), /unknown option 'secret\.client' from the call — nested keys are objects: secret: \{ client: … \}/)
  //! both set, from any two layers: refused naming both sources, never a silent pick (the leaf and the group share a name)
  const both = /are both set — a process holds one: the secret \(a member, or a client trusted with it\) or the client key \(a client that may only follow\); drop one$/
  assert.throws(() => r('shop', { secret: S }, { env: { FERO_SECRET_CLIENT: K } }), (e: Error) => /^fero\('shop'\): secret and secret\.client \(from FERO_SECRET_CLIENT\) are both set/.test(e.message) && both.test(e.message) && !e.message.includes(S) && !e.message.includes(K))
  assert.throws(() => r('shop', { secret: { client: K } }, { env: { FERO_SECRET: S } }), /fero\('shop'\): secret \(from FERO_SECRET\) and secret\.client are both set/)
  assert.throws(() => r('shop', {}, { env: { FERO_SECRET: S, FERO_SHOP_SECRET_CLIENT: K } }), /fero\('shop'\): secret \(from FERO_SECRET\) and secret\.client \(from FERO_SHOP_SECRET_CLIENT\) are both set/)
  assert.throws(() => r('shop', { secret: false }, { env: { FERO_SECRET_CLIENT: K } }), both, 'open on purpose and a client key is a contradiction too')
  assert.throws(() => r('shop', {}, { home, env: { FERO_SECRET: S } }), /fero\('shop'\): secret \(from FERO_SECRET\) and secret\.client \(from a fero\.opt\.ts file \(secret\.client\)\) are both set/)
  //! the SAME rung in the environment: envdeep nests FERO_SECRET_CLIENT under FERO_SECRET and the nested one wins, so the
  // secret would be silently gone — refused on the raw variables, before anything is lost, naming both
  assert.throws(() => r('shop', {}, { env: { FERO_SECRET: S, FERO_SECRET_CLIENT: K } }), (e: Error) => /^fero\('shop'\): FERO_SECRET and FERO_SECRET_CLIENT are both set/.test(e.message) && both.test(e.message) && !e.message.includes(S) && !e.message.includes(K))
  assert.throws(() => r('shop', {}, { env: { FERO_SHOP_SECRET: S, FERO_SHOP_SECRET_CLIENT: K } }), /fero\('shop'\): FERO_SHOP_SECRET and FERO_SHOP_SECRET_CLIENT are both set/)
  assert.throws(() => r('shop', {}, { env: { fero_secret: S, fero_secret_client: K } }), /fero\('shop'\): fero_secret and fero_secret_client are both set/, 'any case: envdeep lowercases')
  //! another resource's same-rung pair is its own business
  assert.deepEqual(cfg('shop', {}, { env: { FERO_USERS_SECRET: S, FERO_USERS_SECRET_CLIENT: K } }), {})
  //! an EMPTY FERO_SECRET_CLIENT= beside FERO_SECRET (a templated variable) would eat the secret in envdeep: dropped first
  assert.deepEqual(cfg('shop', {}, { env: { FERO_SECRET: S, FERO_SECRET_CLIENT: '' } }), { secret: S })
  assert.deepEqual(cfg('shop', {}, { env: { FERO_SHOP_SECRET: S, FERO_SHOP_SECRET_CLIENT: '  ' } }), { secret: S })
  assert.deepEqual(cfg('shop', {}, { env: { FERO_SECRET: S, FERO_SHOP_SECRET_CLIENT: '' } }), { secret: S })
  //! the layer off: the variable is ignored like every other, and the note names it
  const notes: string[] = []
  const note = (line: string) => { notes.push(line) }
  assert.deepEqual(r('shop', {}, { env: { FERO_CONFIG: 'off', FERO_SECRET_CLIENT: K }, note } as never).config, {})
  assert.deepEqual(notes, ['FERO_CONFIG=off: FERO_SECRET_CLIENT is ignored, this process runs open\n'])
  assert.ok(CONFIG_LEAVES.includes('secret.client'))
})

test('the raw-env guard (§15) reads a variable\'s name the way envdeep does — lowercased, split on _, empty parts dropped — so FERO_SECRET__CLIENT, FERO__SECRET_CLIENT and FERO_SECRET_CLIENT_ are FERO_SECRET_CLIENT to it too: an EMPTY one is dropped and FERO_SECRET survives, a set one beside its rung\'s secret is refused naming both variables as typed (the skeptic\'s finding: an exact-spelling match let each one eat the secret, and a loopback server ran open)', () => {
  const K = 'unit-test-client-key-KILO-11-43chars-long-xx'
  const S = 'unit-test-secret-ALPHA-01'
  //! an empty client key under an odd spelling beside the secret: dropped, the secret survives
  for (const odd of ['FERO_SECRET__CLIENT', 'FERO__SECRET_CLIENT', 'FERO_SECRET_CLIENT_', '_FERO_SECRET_CLIENT', 'fero_Secret__Client'])
    assert.deepEqual(cfg('shop', {}, { env: { FERO_SECRET: S, [odd]: '' } }), { secret: S }, odd)
  //! the templated name with an EMPTY resource part on both variables (FERO_${NAME}_SECRET with NAME unset)
  assert.deepEqual(cfg('shop', {}, { env: { FERO__SECRET: S, FERO__SECRET_CLIENT: '' } }), { secret: S })
  assert.deepEqual(cfg('shop', {}, { env: { FERO_SHOP_SECRET: S, FERO_SHOP_SECRET__CLIENT: '' } }), { secret: S })
  //! a SET one beside its rung's secret: refused naming both variables as the user typed them, never a silent swap
  assert.throws(() => r('shop', {}, { env: { FERO_SECRET: S, FERO_SECRET__CLIENT: K } }), /fero\('shop'\): FERO_SECRET and FERO_SECRET__CLIENT are both set/)
  assert.throws(() => r('shop', {}, { env: { FERO__SECRET: S, FERO__SECRET_CLIENT: K } }), /fero\('shop'\): FERO__SECRET and FERO__SECRET_CLIENT are both set/)
  assert.throws(() => r('shop', {}, { env: { FERO_SHOP_SECRET: S, FERO_SHOP_SECRET_CLIENT_: K } }), /fero\('shop'\): FERO_SHOP_SECRET and FERO_SHOP_SECRET_CLIENT_ are both set/)
  //! alone, an odd spelling still reaches the leaf (envdeep's law, unchanged); another resource's odd pair is its own business
  assert.deepEqual(cfg('shop', {}, { env: { FERO_SECRET__CLIENT: K } }), { secret: { client: K } })
  assert.deepEqual(cfg('shop', {}, { env: { FERO_USERS_SECRET: S, FERO_USERS_SECRET__CLIENT: '' } }), {})
})

test('precedence: flag > call > env > project file > home file, per key', () => {
  const cwd = scratch(); const home = scratch()
  fs.writeFileSync(path.join(cwd, 'package.json'), '{ "type": "module" }')
  fs.writeFileSync(path.join(cwd, 'fero.opt.js'), "export default { dir: './project', replicas: 2, heartbeat: { ms: 111 }, listen: '127.0.0.1:4001' }")
  fs.writeFileSync(path.join(home, 'fero.opt.js'), "export default { dir: './home', replicas: 3, redial: { ms: 222 }, rendezvous: '127.0.0.1:4002' }")
  const s = { cwd, home, argv: ['--fero.dir', './flag'], env: { FERO_REPLICAS: '4', FERO_HEARTBEAT_MS: '333' } }
  const { config, from } = r('shop', { replicas: 5 }, s)
  assert.deepEqual(config, { dir: './flag', replicas: 5, heartbeat: { ms: 333 }, redial: { ms: 222 }, listen: '127.0.0.1:4001', rendezvous: '127.0.0.1:4002' })
  assert.equal(from('dir'), '--fero.dir')
  assert.equal(from('replicas'), 'the call')
  assert.equal(from('heartbeat.ms'), 'FERO_HEARTBEAT_MS')
  assert.equal(from('redial.ms'), 'a fero.opt.ts file (redial.ms)')
  assert.equal(from('listen'), 'a fero.opt.ts file (listen)')
  //! the project file beats the home file inside the file layer (optcascade's own order)
  assert.equal(cfg('shop', {}, { cwd, home }).dir, './project')
})

test('the nested spelling survives every layer: env is lowercased and split on _, flags nest on .', () => {
  assert.deepEqual(cfg('r', {}, { env: { FERO_HEARTBEAT_MS: '9', FERO_JOURNAL_CAP: '64', FERO_REDIAL_MS: '7' } }), { heartbeat: { ms: 9 }, journal: { cap: 64 }, redial: { ms: 7 } })
  assert.deepEqual(cfg('r', {}, { argv: ['--fero.heartbeat.ms', '9', '--fero.journal.cap=64'] }), { heartbeat: { ms: 9 }, journal: { cap: 64 } })
})

test('the old camelCase spellings are refused with the pointer, from every layer', () => {
  assert.throws(() => r('r', { heartbeatMs: 5 }), /'heartbeatMs' is spelled heartbeat: \{ ms \} since V4-10 — in the call heartbeat: \{ ms: … \}, as a flag --fero\.heartbeat\.ms, in the environment FERO_HEARTBEAT_MS/)
  assert.throws(() => r('r', {}, { env: { FERO_HEARTBEATMS: '5' } }), /'heartbeatms' is spelled heartbeat: \{ ms \}/)
  //! a flag's key arrives lowercased (optcascade >= 1.1.0), so the pointer names that spelling
  assert.throws(() => r('r', {}, { argv: ['--fero.redialMs', '5'] }), /'redialms' is spelled redial: \{ ms \}/)
  assert.throws(() => r('r', { journalCap: 5 }), /'journalCap' is spelled journal: \{ cap \}/)
})

test('unknown keys throw naming their source, with the nearest declared spelling', () => {
  assert.throws(() => r('r', { hots: ['a'] }), /unknown option 'hots' from the call — did you mean hosts$/)
  assert.throws(() => r('r', { heartbeat: { sec: 1 } }), /unknown option 'heartbeat\.sec' from the call — did you mean heartbeat: \{ ms: … \}/)
  assert.throws(() => r('r', { heartbeat: 5 }), /'heartbeat' from the call is a group, not a value — did you mean heartbeat: \{ ms: … \}/)
  assert.throws(() => r('r', { heartbeat: null }), /'heartbeat' from the call is a group, not a value/)
  assert.throws(() => r('r', {}, { env: { FERO_HOTS: 'a' } }), /unknown option 'hots' from FERO_HOTS — did you mean FERO_HOSTS/)
  assert.throws(() => r('r', {}, { argv: ['--fero.replica', '2'] }), /unknown option 'replica' from --fero\.replica — did you mean --fero\.replicas/)
  assert.throws(() => r('r', {}, { argv: ['--fero.heartbeat.sec', '2'] }), /unknown option 'heartbeat\.sec' from --fero\.heartbeat\.sec — did you mean --fero\.heartbeat\.ms/)
  //! a group used as a value; a near miss of a group hints the group's LEAF, never the group
  assert.throws(() => r('r', {}, { argv: ['--fero.heartbeat', '5'] }), /'heartbeat' from --fero\.heartbeat is a group, not a value — did you mean --fero\.heartbeat\.ms/)
  assert.throws(() => r('r', {}, { env: { FERO_HEARTBEATS_MS: '5' } }), /unknown option 'heartbeats' from FERO_HEARTBEATS — did you mean FERO_HEARTBEAT_MS/)
  assert.throws(() => r('r', {}, { env: { FERO_HEARTBEATS: '5' } }), /unknown option 'heartbeats' from FERO_HEARTBEATS — did you mean FERO_HEARTBEAT_MS/)
  //! a dotted key in the call or a file is a flat spelling of a nested key
  assert.throws(() => r('r', { 'heartbeat.ms': 1 } as never), /unknown option 'heartbeat\.ms' from the call — nested keys are objects: heartbeat: \{ ms: … \}/)
  //! a key that exists only on Object.prototype is unknown, never a crash; so is a resource named after one
  assert.throws(() => r('r', { constructor: { dir: 'x' } } as never), /unknown option 'constructor' from the call/)
  assert.throws(() => r('r', { toString: 1 } as never), /unknown option 'toString' from the call/)
  assert.deepEqual(cfg('constructor', {}, { env: { FERO_DIR: './g', FERO_CONSTRUCTOR_DIR: './c' } }), { dir: './c' })
  assert.deepEqual(cfg('r', {}, { env: { FERO_CONSTRUCTOR_DIR: './c' } }), {})
  //! a bad flag set is named twice: fero says which layer it was reading, and which two flags clash — from their
  // names, never from optcascade's TypeError, which quotes the first flag's value (a secret, when it is one)
  assert.throws(() => r('r', {}, { argv: ['--fero.heartbeat', '5', '--fero.heartbeat.ms', '7'] }), /fero\('r'\): could not read the launch flags — --fero\.heartbeat and --fero\.heartbeat\.ms clash: a key is a value or a group, never both — set one of them$/)
  //! a flag's key is read lowercased at every depth, as a variable's is (optcascade >= 1.1.0):
  // `--fero.Dir`, `--FERO.dir` and `FERO_DIR` are one key — nothing is parsed under another name
  assert.deepEqual(cfg('r', {}, { argv: ['--FERO.dir', 'x'] }), { dir: 'x' })
  assert.deepEqual(cfg('r', {}, { argv: ['--fero.Dir', 'y'] }), { dir: 'y' })
  assert.deepEqual(cfg('r', {}, { argv: ['--no-Fero.rendezvous'] }), { rendezvous: false })
  //! a seam keeps its pre-V4-10 message (api/index.test.ts pins it)
  assert.throws(() => r('r', { seams: { hash: () => 0 } }), /unknown seam 'hash' — M5a ships validation/)
  //! the call never carries another resource's subtree: an unknown object in the call is a typo too
  assert.throws(() => r('r', { other: { dir: 'x' } }), /unknown option 'other' from the call/)
})

test('FERO_CONFIG and FERO_DIAG_TOKEN are not config: stripped before optcascade sees the environment', () => {
  assert.deepEqual(cfg('r', {}, { env: { FERO_CONFIG: 'on', FERO_DIAG_TOKEN: 'sekrit' } }), {})
  assert.throws(() => r('r', {}, { env: { FERO_CONFIG: 'maybe' } }), /FERO_CONFIG='maybe' — it is 'off' \(the call alone\), 'on', or unset/)
})

test('call-only keys: a function or a per-instance switch cannot come from a flag, a variable or a file', () => {
  assert.throws(() => r('r', {}, { env: { FERO_SIGNALS: 'false' } }), /'signals' cannot come from FERO_SIGNALS — it is set in the call only \(V4-8/)
  assert.throws(() => r('r', {}, { argv: ['--fero.methods.sell', '1'] }), /'methods' cannot come from --fero\.methods — it is set in the call only/)
  assert.throws(() => r('r', {}, { argv: ['--fero.seams.validation', '1'] }), /'seams\.validation' cannot come from --fero\.seams\.validation — it is set in the call only \(a function\)/)
  assert.throws(() => r('r', {}, { argv: ['--fero.data.k', '1'] }), /'data' cannot come from --fero\.data — it is set in the call or a fero\.opt\.ts file only/)
  const home = scratch()
  fs.writeFileSync(path.join(home, 'fero.opt.js'), "export default { uuid: 'shared' }")
  //! the refusal names the layers the key MAY come from (it said "the call only" for uuid, which rides a flag and a variable)
  assert.throws(() => r('r', {}, { home }), /'uuid' cannot come from a fero\.opt\.ts file \(uuid\) — it is set in a flag, the call or the environment only \(one shared file would give every process the same identity\)/)
  //! data DOES ride a file (rows are data, not code)
  const home2 = scratch()
  fs.writeFileSync(path.join(home2, 'fero.opt.js'), "export default { data: { widgets: { stock: 1 } } }")
  assert.deepEqual(cfg('r', {}, { home: home2 }), { data: { widgets: { stock: 1 } } })
})

test('coercions: hosts CSV, off/false/0 for rendezvous and listen, server 1/true, numeric-looking uuid refused', () => {
  assert.deepEqual(cfg('r', {}, { env: { FERO_HOSTS: 'a:1, b:2,,' } }).hosts, ['a:1', 'b:2'])
  assert.deepEqual(cfg('r', {}, { argv: ['--fero.hosts', 'a:1,b:2', '--fero.hosts', 'c:3'] }).hosts, ['a:1', 'b:2', 'c:3'])
  //! the call is typed and stays as written — the composer refuses a CSV string or `server: 1` there
  assert.equal(cfg('r', { hosts: 'a:1,b:2' }).hosts, 'a:1,b:2')
  assert.equal(cfg('r', { server: 1 }).server, 1)
  for (const off of ['off', 'false', '0', ' off ']) assert.equal(cfg('r', {}, { env: { FERO_RENDEZVOUS: off } }).rendezvous, false, off)
  assert.equal(cfg('r', {}, { argv: ['--no-fero.rendezvous'] }).rendezvous, false)
  assert.equal(cfg('r', {}, { argv: ['--no-fero.listen'] }).listen, false)
  assert.equal(cfg('r', {}, { env: { FERO_LISTEN: 'off' } }).listen, false)
  assert.equal(cfg('r', {}, { env: { FERO_RENDEZVOUS: '127.0.0.1:4000' } }).rendezvous, '127.0.0.1:4000')
  //! '' = unset for EVERY key from a string layer: the next rung down answers (a templated FERO_DIR= in
  // a container is not a refusal)
  assert.equal(cfg('r', {}, { env: { FERO_LISTEN: '' } }).listen, undefined)
  assert.deepEqual(cfg('r', { dir: './call' }, { env: { FERO_DIR: '', FERO_SERVER: '', FERO_HEARTBEAT_MS: '  ', FERO_UUID: '', FERO_REPLICAS: '', FERO_HOSTS: ' , ' }, argv: ['--fero.hosts='] }), { dir: './call' })
  assert.equal(cfg('r', {}, { env: { FERO_SERVER: '1' } }).server, true)
  assert.equal(cfg('r', {}, { argv: ['--fero.server'] }).server, true)
  assert.equal(cfg('r', {}, { env: { FERO_SERVER: 'false' } }).server, false)
  //! the client pin is sticky: server: false anywhere refuses server: true from a higher rung
  assert.throws(() => r('r', { server: false }, { argv: ['--fero.server'] }), /server: true \(from --fero\.server\) but server: false pins the client role — drop one/)
  assert.throws(() => r('r', { server: true }, { env: { FERO_SERVER: '0' } }), /server: true but server: false pins the client role \(from FERO_SERVER\) — drop one/)
  assert.equal(cfg('r', { server: false }, { argv: ['--no-fero.server'] }).server, false)
  assert.throws(() => r('r', {}, { argv: ['--fero.uuid', '12345678'] }), /uuid looks like a number \(12345678\) \(from --fero\.uuid\) — .* give it a letter, or set it in the call/)
  //! garbage stays garbage for the composer to refuse with the source named (its isAddr check)
  assert.equal(cfg('r', {}, { env: { FERO_RENDEZVOUS: 'garbage' } }).rendezvous, 'garbage')
  assert.equal(cfg('r', {}, { env: { FERO_HEARTBEAT_MS: 'abc' } }).heartbeat && (cfg('r', {}, { env: { FERO_HEARTBEAT_MS: 'abc' } }).heartbeat as { ms: unknown }).ms, 'abc')
})

test('the per-resource rung beats the global rung inside every layer, and is validated like any layer', () => {
  const home = scratch()
  fs.writeFileSync(path.join(home, 'fero.opt.js'), "export default { dir: './all', shop: { dir: './shop-file', journal: { cap: 8 } } }")
  const s = { home, argv: ['--fero.dir', './g-flag', '--fero.shop.dir', './shop-flag'], env: { FERO_HEARTBEAT_MS: '50', FERO_SHOP_HEARTBEAT_MS: '60', FERO_USERS_DIR: './users-env' } }
  const shop = r('shop', {}, s)
  assert.deepEqual(shop.config, { dir: './shop-flag', heartbeat: { ms: 60 }, journal: { cap: 8 } })
  assert.equal(shop.from('dir'), '--fero.shop.dir')
  assert.equal(shop.from('heartbeat.ms'), 'FERO_SHOP_HEARTBEAT_MS')
  assert.equal(shop.from('journal.cap'), 'a fero.opt.ts file (shop.journal.cap)')
  const users = r('users', {}, s)
  assert.deepEqual(users.config, { dir: './g-flag', heartbeat: { ms: 50 } })
  assert.equal(users.from('dir'), '--fero.dir')
  //! the call still beats a scoped env value (the call is the second rung; env is fourth)
  assert.equal(cfg('shop', { dir: './call' }, s).dir, './shop-flag')
  assert.equal(cfg('shop', { heartbeat: { ms: 1 } }, s).heartbeat && (cfg('shop', { heartbeat: { ms: 1 } }, s).heartbeat as { ms: number }).ms, 1)
  //! a typo INSIDE the resource's own subtree throws
  assert.throws(() => r('shop', {}, { env: { FERO_SHOP_DIRR: 'x' } }), /unknown option 'dirr' from FERO_SHOP_DIRR — did you mean FERO_SHOP_DIR/)
  //! another resource's subtree is left alone — sibling names one edit apart included (order/orders,
  // shop1/shop2), and a misspelt scoped name sets nothing (diag(f).config() shows what was read)
  assert.deepEqual(cfg('shop', {}, { env: { FERO_SHOPP_DIR: 'x', FERO_SHOP_DIR: 'y' } }), { dir: 'y' })
  assert.deepEqual(cfg('order', {}, { env: { FERO_ORDER_DIR: './a', FERO_ORDERS_DIR: './b' } }), { dir: './a' })
  assert.deepEqual(cfg('orders', {}, { env: { FERO_ORDER_DIR: './a', FERO_ORDERS_DIR: './b' } }), { dir: './b' })
  assert.deepEqual(cfg('shop1', {}, { argv: ['--fero.shop1.dir', './1', '--fero.shop2.dir', './2'] }), { dir: './1' })
  //! a resource whose name is near a declared key still has its own rung (host/hosts, journals/journal)
  assert.deepEqual(cfg('host', {}, { env: { FERO_HOST_DIR: './h' } }), { dir: './h' })
  assert.deepEqual(cfg('journals', {}, { env: { FERO_JOURNALS_DIR: './j', FERO_JOURNAL_CAP: '8' } }), { dir: './j', journal: { cap: 8 } })
  //! a near miss of a declared GROUP is a typo, not another resource (an object can only be a group)
  assert.throws(() => r('shop', {}, { env: { FERO_HEARTBEATS_MS: '5' } }), /unknown option 'heartbeats' from FERO_HEARTBEATS — did you mean FERO_HEARTBEAT_MS/)
  assert.throws(() => r('shop', {}, { argv: ['--fero.journals.cap', '5'] }), /unknown option 'journals' from --fero\.journals — did you mean --fero\.journal\.cap/)
  //! ... unless the object holds a declared option: then it is a resource's rung, whatever its name is near. The
  // `leave` group (wave 5c) sits two edits from live, lease, level, league, save, wave and lane; `seams` from teams;
  // `diag` from dial — a sibling resource so named must not stop this one from starting (every layer, both rungs)
  for (const sibling of ['live', 'lease', 'level', 'league', 'save', 'wave', 'lane', 'teams', 'dial'])
    assert.deepEqual(cfg('shop', {}, { env: { [`FERO_${sibling.toUpperCase()}_HEARTBEAT_MS`]: '100' } }), {}, `${sibling}'s rung is its own business`)
  assert.deepEqual(cfg('shop', {}, { argv: ['--fero.live.dir', './live', '--fero.teams.replicas', '2'] }), {})
  assert.deepEqual(cfg('live', {}, { env: { FERO_LIVE_HEARTBEAT_MS: '100' } }), { heartbeat: { ms: 100 } }, 'and the sibling reads it')
  const sib = scratch()
  fs.writeFileSync(path.join(sib, 'package.json'), '{ "type": "module" }')
  fs.writeFileSync(path.join(sib, 'fero.opt.js'), "export default { live: { heartbeat: { ms: 100 } }, lease: { ms: 5 } }")
  assert.throws(() => r('shop', {}, { cwd: sib }), /unknown option 'lease' from a fero\.opt\.ts file \(lease\) — did you mean a fero\.opt\.ts file \(leave\.ms\)/, 'a near miss holding only a group\'s leaf is still the typo')
  const sib2 = scratch() // a second dir: a module file, once imported, is cached under its path
  fs.writeFileSync(path.join(sib2, 'package.json'), '{ "type": "module" }')
  fs.writeFileSync(path.join(sib2, 'fero.opt.js'), "export default { live: { heartbeat: { ms: 100 } } }")
  assert.deepEqual(cfg('shop', {}, { cwd: sib2 }), {}, 'the file layer: live beside leave is a resource')
  assert.throws(() => r('shop', {}, { env: { FERO_LEASE_MS: '5' } }), /unknown option 'lease' from FERO_LEASE — did you mean FERO_LEAVE_MS/)
  //! the rule reads the group's OWN options, not any declared name (the review's escapes, 2026-10-10): a near miss that
  // holds the group's leaf is the typo even beside a declared option, the hint names THAT leaf, and a typo INSIDE a
  // sibling's rung is the sibling's to catch when it composes — not a near miss of a group this resource never named
  assert.throws(() => r('shop', {}, { env: { FERO_SEAM_VALIDATION: 'x' } }), /unknown option 'seam' from FERO_SEAM — did you mean FERO_SEAMS_VALIDATION/, 'seam beside seams holds its leaf: a typo')
  assert.throws(() => r('shop', {}, { env: { FERO_REDIALS_TRIES: '3', FERO_REDIALS_DIR: 'x' } }), /unknown option 'redials' from FERO_REDIALS — did you mean FERO_REDIAL_TRIES/, 'redials holds a redial leaf: a typo, whatever else it holds')
  assert.deepEqual(cfg('shop', {}, { env: { FERO_LIVE_HEARTBEATS_MS: '100' } }), {}, "a typo inside live's rung is live's business, not a near miss of leave")
  //! a scalar under an unknown name is a typo too (a resource's subtree is an object)
  assert.throws(() => r('shop', {}, { env: { FERO_WIDGETS: '5' } }), /unknown option 'widgets' from FERO_WIDGETS/)
  assert.throws(() => r('shop', {}, { argv: ['--fero.shp', 'x'] }), /unknown option 'shp' from --fero\.shp$/)
})

test('nameKey: lowercase [a-z0-9]+ and not a declared key; anything else gets the global rung only', () => {
  assert.equal(nameKey('Shop'), 'shop')
  assert.equal(nameKey('my-shop'), null)
  assert.equal(nameKey('my shop'), null)
  assert.equal(nameKey('a_b'), null)
  assert.equal(nameKey('#directory'), null)
  for (const k of ['journal', 'heartbeat', 'hosts', 'data', 'seams']) assert.equal(nameKey(k), null, k)
  //! a name that cannot be scoped reads the global rung and nothing else — the would-be subtree is skipped
  assert.deepEqual(cfg('my-shop', {}, { env: { FERO_DIR: './g', FERO_MYSHOP_DIR: './x' } }), { dir: './g' })
})

test('FERO_CONFIG=off: the call alone, and zero reads of argv, env or the filesystem', () => {
  const home = scratch()
  fs.writeFileSync(path.join(home, 'fero.opt.js'), "export default { dir: './file' }")
  const argv = ['--fero.dir', './flag']
  const env = { FERO_CONFIG: 'off', FERO_DIR: './env', FERO_HOTS: 'would-throw' }
  const { config, from } = r('r', { server: true }, { argv, env, home })
  assert.deepEqual(config, { server: true })
  assert.equal(from('dir'), 'the default')
  //! the call is still checked (a typo in code is loud with the layer off too)
  assert.throws(() => r('r', { hots: ['a'] }, { argv: [], env: { FERO_CONFIG: 'off' } }), /unknown option 'hots' from the call/)
})

test('the file walk is memoized per (cwd, home): a file that appears later is not seen by that pair, a new pair sees its own', () => {
  const cwd = scratch(); const home = scratch()
  assert.deepEqual(cfg('a', {}, { cwd, home }), {})
  fs.writeFileSync(path.join(home, 'fero.opt.js'), "export default { dir: './late' }")
  //! the same pair answers from the memo — no second walk, exactly as optcascade never re-reads a file
  assert.deepEqual(cfg('b', {}, { cwd, home }), {})
  const home2 = scratch()
  fs.writeFileSync(path.join(home2, 'fero.opt.js'), "export default { dir: './fresh' }")
  assert.deepEqual(cfg('c', {}, { cwd, home: home2 }), { dir: './fresh' })
})

test('a config file that fails to load throws with its path (optcascade), and the leaves list is the table\'s contract', () => {
  const home = scratch()
  fs.writeFileSync(path.join(home, 'fero.opt.js'), 'export default {')
  assert.throws(() => r('r', {}, { home }), (e: Error) => e.message.includes(path.join(home, 'fero.opt.js')))
  assert.deepEqual([...CONFIG_LEAVES], ['uuid', 'server', 'listen', 'hosts', 'dir', 'heartbeat.ms', 'redial.ms', 'redial.tries', 'leave.ms', 'journal.cap', 'replicas', 'rendezvous', 'diag.allow', 'secret', 'secret.client', 'data', 'methods', 'validation', 'seams.validation', 'signals'])
})

test('leave.ms (the knock window, DESIGN-LEAVE §10.7) rides every layer under the nested spelling, scoped by name, with its provenance', () => {
  assert.deepEqual(cfg('shop', { leave: { ms: 30000 } }), { leave: { ms: 30000 } })
  assert.deepEqual(cfg('shop', {}, { argv: ['--fero.leave.ms', '30000'] }), { leave: { ms: 30000 } })
  assert.deepEqual(cfg('shop', {}, { env: { FERO_LEAVE_MS: '30000' } }), { leave: { ms: 30000 } })
  assert.deepEqual(cfg('shop', {}, { env: { FERO_LEAVE_MS: '0' } }), { leave: { ms: 0 } }, '0 is a value (the bound alone), not unset')
  const cwd = scratch()
  fs.writeFileSync(path.join(cwd, 'package.json'), '{ "type": "module" }')
  fs.writeFileSync(path.join(cwd, 'fero.opt.js'), "export default { leave: { ms: 5000 }, shop: { leave: { ms: 9000 } } }")
  const shop = r('shop', {}, { cwd })
  assert.deepEqual(shop.config, { leave: { ms: 9000 } }, 'the name rung beats the global one inside the file layer')
  assert.equal(shop.from('leave.ms'), 'a fero.opt.ts file (shop.leave.ms)')
  assert.equal(r('users', {}, { cwd }).from('leave.ms'), 'a fero.opt.ts file (leave.ms)')
  assert.equal(r('users', { leave: { ms: 1 } }, { cwd }).from('leave.ms'), 'the call')
  //! the group's shape is checked like heartbeat's: a bare value, a flat key and a stray leaf are refused with the hint
  assert.throws(() => r('r', { leave: 5 } as never), /'leave' from the call is a group, not a value — did you mean leave: \{ ms: … \}/)
  assert.throws(() => r('r', { 'leave.ms': 5 } as never), /unknown option 'leave\.ms' from the call — nested keys are objects: leave: \{ ms: … \}/)
  assert.throws(() => r('r', {}, { argv: ['--fero.leave.sec', '5'] }), /unknown option 'leave\.sec' from --fero\.leave\.sec — did you mean --fero\.leave\.ms/)
  assert.throws(() => r('r', {}, { env: { FERO_LEAVE_MS_OLD: '5' } }), /unknown option 'leave\.ms\.old' from FERO_LEAVE_MS_OLD — leave\.ms takes a value, not a group$/)
})

test('I-35 — a LONGER name under a leaf is refused naming THAT name; the good variable beside it is never blamed, and `data` (an object of rows) still rides a file', () => {
  //! the env layer splits on _, so FERO_RENDEZVOUS_UNUSED is the nested key rendezvous.unused — an OBJECT at a
  // leaf. It used to win the merge over the good FERO_RENDEZVOUS, reach the composer as {unused: 1}, and the
  // refusal there blamed FERO_RENDEZVOUS (the one variable that was right)
  assert.throws(() => r('r', {}, { env: { FERO_RENDEZVOUS: '127.0.0.1:12345', FERO_RENDEZVOUS_UNUSED: '1' } }), /unknown option 'rendezvous\.unused' from FERO_RENDEZVOUS_UNUSED — rendezvous takes a value, not a group$/)
  assert.throws(() => r('r', {}, { env: { FERO_DIR: './x', FERO_DIR_OLD: './y' } }), /unknown option 'dir\.old' from FERO_DIR_OLD — dir takes a value, not a group$/)
  assert.throws(() => r('r', {}, { env: { FERO_DIR_OLD: './y' } }), /unknown option 'dir\.old' from FERO_DIR_OLD/, 'alone too — no good value needed to be wrong')
  //! the same under the name rung, as a flag, and in a file — each named in its own spelling
  assert.throws(() => r('shop', {}, { env: { FERO_SHOP_DIR: './x', FERO_SHOP_DIR_OLD: './y' } }), /unknown option 'dir\.old' from FERO_SHOP_DIR_OLD — dir takes a value, not a group$/)
  assert.throws(() => r('r', {}, { argv: ['--fero.rendezvous.unused', '1'] }), /unknown option 'rendezvous\.unused' from --fero\.rendezvous\.unused — rendezvous takes a value, not a group$/)
  const bad = scratch()
  fs.writeFileSync(path.join(bad, 'package.json'), '{ "type": "module" }')
  fs.writeFileSync(path.join(bad, 'fero.opt.js'), "export default { dir: { old: './y' } }")
  assert.throws(() => r('r', {}, { cwd: bad }), /unknown option 'dir\.old' from a fero\.opt\.ts file \(dir\.old\) — dir takes a value, not a group$/)
  //! `data` IS an object (rows): the one leaf a file may carry as one (a second cwd — the file walk is memoized per pair)
  const good = scratch()
  fs.writeFileSync(path.join(good, 'package.json'), '{ "type": "module" }')
  fs.writeFileSync(path.join(good, 'fero.opt.js'), "export default { data: { row: { n: 1 } }, dir: './d' }")
  assert.deepEqual(cfg('r', {}, { cwd: good }), { data: { row: { n: 1 } }, dir: './d' })
})
