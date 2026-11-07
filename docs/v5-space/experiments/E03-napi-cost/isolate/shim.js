// The few host functions data's bundle names that a bare isolate lacks. None is on the
// hot lane's path (checked in the bundle: structuredClone only in reducers and connect,
// performance.now only when stats are on, setTimeout only in the DOM scheduler).
(function () {
  var g = globalThis
  if (typeof g.console === 'undefined') g.console = { log: function () {}, warn: function () {}, error: function () {} }
  if (typeof g.performance === 'undefined') g.performance = { now: function () { return Date.now() } }
  if (typeof g.queueMicrotask === 'undefined') g.queueMicrotask = function (f) { Promise.resolve().then(f) }
  if (typeof g.structuredClone === 'undefined') g.structuredClone = function (v) { return JSON.parse(JSON.stringify(v)) }
  if (typeof g.setTimeout === 'undefined') g.setTimeout = function (f) { Promise.resolve().then(f); return 0 }
})()
