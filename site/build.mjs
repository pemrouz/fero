// build.mjs — assemble index.html from page.html + sections/<name>.html in ORDER; link every
// sections/<name>.css and sections/<name>.js that exists; fill the masthead nav from NAV.
// Idempotent; safe to run concurrently from several builders.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const { order: ORDER, nav: NAV } = JSON.parse(readFileSync(join(here, 'order.json'), 'utf8'))
const page = readFileSync(join(here, 'page.html'), 'utf8')
let sections = '', styles = '', scripts = ''
const present = []
for (const name of ORDER) {
  const html = join(here, 'sections', `${name}.html`)
  if (!existsSync(html)) continue
  present.push(name)
  sections += `\n  <!-- ===== ${name} ===== -->\n` + readFileSync(html, 'utf8').trim() + '\n'
  if (existsSync(join(here, 'sections', `${name}.css`))) styles += `  <link rel="stylesheet" href="./sections/${name}.css">\n`
  if (existsSync(join(here, 'sections', `${name}.js`))) scripts += `<script type="module" src="./sections/${name}.js"></script>\n`
}
const nav = NAV.filter(([id]) => present.includes(id)).map(([id, text]) => `      <a href="#${id}">${text}</a>`).join('\n')
// section numerals are literal typography, not figures: exempt them from the audit
const literalNos = sections.replace(/<span class="sec-no">/g, '<span class="sec-no" data-literal>')
const out = page.replace('<!-- @sections -->', literalNos).replace('<!-- @styles -->\n', styles).replace('<!-- @scripts -->\n', scripts).replace('<!-- @nav -->', nav)
writeFileSync(join(here, 'index.html'), out)
console.log(`index.html ← ${present.length ? present.join(', ') : '(no sections yet)'}`)
