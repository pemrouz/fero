# Probe P2: the numbers

Made by `summarize.mjs` from `timing.jsonl`. Each cell is the median of the runs' medians; the range is across runs.
**Provisional:** taken on a shared cloud machine, not on the quiet machine where bars are judged.

Runs: 3. The machine's one-minute load average before each bench (Node, then native, run by run): 1.63, 1.73, 1.67, 2.41, 2.41, 2.42.

## 200 seeds

| How | ms for 200 seeds | range of run medians | events | events per seed | ns per event |
|---|---:|---|---:|---:|---:|
| **WASM under Node, one instance, data folding (the bar: 1,000 ms)** | 302.9 | 296.5 to 339 | 412276 | 2061.4 | 735 |
| WASM under Node, one instance, no fold | 221.9 | 220.6 to 227.2 | 412276 | 2061.4 | 538 |
| Native, no Node, no fold | 169.7 | 169.3 to 189.9 | 412276 | 2061.4 | 412 |
| WASM under Node, a new instance per seed, data folding (reference) | 369.2 | 360.9 to 383.6 | 412276 | 2061.4 | 895 |

## A fresh world plus a scenario

| How | p50 ms | p99 ms | range of the runs' p99 | p99.9 ms | max ms (median of runs) | largest max | events per world |
|---|---:|---:|---|---:|---:|---:|---:|
| **One instance, reset in place (the bar: p99 5 ms)** | 0.113 | 0.250 | 0.185 to 0.263 | 3.334 | 3.84 | 7.03 | 231.0 |
| A new instance per world (reference) | 0.372 | 5.027 | 4.772 to 5.63 | 39.154 | 41.17 | 100.67 | 231.0 |

## The module

- Size: 317659 bytes.
- Compile: 49 microseconds (the engine compiles lazily; the work moves to the first calls). Make an instance: 353 microseconds.
- One pass of 200 seeds calls JavaScript 22453 times, with 35159 entries, 32511 of them client writes. 704 folds start again after a restart. The instance's memory after it: 1245184 bytes.
