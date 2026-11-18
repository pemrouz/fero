// Runs links.js in headless Chromium (Playwright 1.63.0, Chrome for Testing 153), one fresh page per mode.
//   node run.mjs <idle|busy|busy-writes> [marks ms, comma separated]
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire('/opt/node-tools/node_modules/')
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers'
const { chromium } = require('playwright')
const mode = process.argv[2], marks = (process.argv[3] ?? '100,1000,5000,15000,30000').split(',').map(Number)
const browser = await chromium.launch()
const page = await browser.newPage()
await page.setContent('<!doctype html><html><body></body></html>')
await page.addScriptTag({ content: readFileSync(fileURLToPath(new URL('./links.js', import.meta.url)), 'utf8') })
const res = await page.evaluate(([m, k]) => window.runLinks(m, k), [mode, marks])
console.log(JSON.stringify({ exp: 'E-55', claim: 13, bench: 'browser', browser: browser.version(), ...res }))
await browser.close()
