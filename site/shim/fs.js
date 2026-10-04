// shim/fs.js — node:fs for the browser copy of sim/shrink.ts. Only its CLI block calls these; it never runs here.
const no = (name) => () => { throw new Error(`node:fs ${name} is not available in the browser`) }
export const mkdirSync = no('mkdirSync')
export const readFileSync = no('readFileSync')
export const writeFileSync = no('writeFileSync')
