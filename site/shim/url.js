// shim/url.js — node:url for the browser copy of sim/shrink.ts (its isMain check is wrapped in try/catch).
export const pathToFileURL = () => { throw new Error('node:url is not available in the browser') }
