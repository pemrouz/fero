// E-40 (a): how big is `data` plus a fero client, as a browser bundle?
//   node bundle.mjs <outDir>          (esbuild from $SP/dl/esbuild, fetched by fetch.sh)
// Builds four minified ESM bundles for browsers (esbuild, target es2022, tree-shaking on) and prints raw,
// gzip -9 and brotli sizes as JSON lines:
//   data-all    every export of data/api/index.ts (what `import * as data` costs)
//   data-used   only what the client imports from data ($ and lane), tree-shaken
//   codec       fero v4's frame codec (kernel/codec.ts) alone
//   client      the prototype client (client/fero-client.ts): data's $ and lane + the codec + the wire and door
// It also writes client.mjs (the `client` bundle) into outDir, for the cold-client runs.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const SP = process.env.SP || '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad'
const esbuild = createRequire(`${SP}/dl/esbuild/package.json`)('esbuild')
const DATA = process.env.DATA || '/home/user/pemrouz/data'
const FERO = path.resolve(HERE, '../../../..')
const out = process.argv[2] || `${SP}/e40/static`
fs.mkdirSync(out, { recursive: true })

const entries = {
  'data-all': `export * from ${JSON.stringify(DATA + '/api/index.ts')}`,
  'data-used': `export { $, lane } from ${JSON.stringify(DATA + '/api/index.ts')}`,
  codec: `export { Frame, encodeFrame } from ${JSON.stringify(FERO + '/kernel/codec.ts')}`,
  client: `export * from ${JSON.stringify(HERE + '/client/fero-client.ts')}`,
}
for (const [name, src] of Object.entries(entries)) {
  const r = await esbuild.build({ stdin: { contents: src, resolveDir: HERE, loader: 'ts', sourcefile: name + '.ts' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, treeShaking: true, write: false, metafile: true, logLevel: 'error' })
  const code = r.outputFiles[0].contents
  if (name === 'client') fs.writeFileSync(path.join(out, 'client.mjs'), code)
  const inputs = Object.keys(r.metafile.inputs).length
  console.log(JSON.stringify({ exp: 'E-40', part: 'bundle', name, esbuild: esbuild.version, modules: inputs, raw_bytes: code.length,
    gzip9_bytes: zlib.gzipSync(code, { level: 9 }).length, brotli_bytes: zlib.brotliCompressSync(code, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length }))
}
