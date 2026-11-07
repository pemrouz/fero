// E-03 part 3: the same JS work in every host (Node, deno_core's V8 isolate, QuickJS).
// Loaded after data's bundle (globalThis.D). Defines globalThis.W:
//   W.setup(rows)   a source of `rows` rows and data's hot lane over it, 8 batches of 256 records
//   W.fold(iters)   apply `iters` batches through the lane; returns records applied
//   W.loop(iters)   an empty JS loop (the host's loop floor)
// Plain script, no host API, so the three hosts run byte-identical JS. Records are the shape
// fero v4 folds (api/substrate.ts): { type: 0, key: [row, field?], value }.
(function () {
  var D = globalThis.D
  var B = 256, NB = 8
  var lane = null, batches = null
  function makeBatch(rows, salt) {
    var recs = []
    for (var i = 0; i < B; i++) {
      var k = 'u' + ((i * 7 + salt) % rows)
      if (i % 2 === 0) recs.push({ type: 0, key: [k, 'n'], value: i + salt })
      else recs.push({ type: 0, key: [k], value: { name: 'user', n: i + salt, tags: ['a', 'b'] } })
    }
    return recs
  }
  globalThis.W = {
    setup: function (rows) {
      var init = {}
      for (var i = 0; i < rows; i++) init['u' + i] = { name: 'user', n: i, tags: ['a', 'b'] }
      var src = D.$(init)
      lane = D.lane(src, { onReject: function (r) { throw r.error } })
      batches = []
      for (var s = 0; s < NB; s++) batches.push(makeBatch(rows, s + 1))
      return rows
    },
    fold: function (iters) {
      var a = 0
      for (var i = 0; i < iters; i++) a += lane(batches[i % NB]).applied
      return a
    },
    loop: function (iters) {
      var a = 0
      for (var i = 0; i < iters; i++) a = (a + i) | 0
      return a
    },
  }
})()
