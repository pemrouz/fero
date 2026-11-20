# E-57 probes: the small checks TRANSFORMS.md cites

These are the probes that [TRANSFORMS.md](../../../TRANSFORMS.md) leans on but that ran before E-57 was built: the critic's two probes, the ground study's two data probes, and the skeptic's probe of `min` and `max`. They were kept in working folders at first; the skeptic asked for them here (finding F20), so a reader can rerun every one. Each runs on data's real engine at commit `63fea66`, read only. Nothing in data was changed.

**Words.** A **probe** is a short script that shows one fact about data, not a seeded run with an oracle. **Untimed** probes print what data answers; the one **timed** probe ran three times, each process alone on the box under the timing lock.

| Probe | What it shows | Output | Cited in |
|---|---|---|---|
| [ordcost.mjs](ordcost.mjs), [ordcost.sh](ordcost.sh) | the critic's timed probe: what data's `za('points', 10)` costs per write at 1e4, 1e5 and 1e6 rows (sort-field writes one commit each, other-field writes, batches of 256), and its build | [ordcost.jsonl](ordcost.jsonl): three runs; at 1e6 rows the view adds 1,305 to 1,385 µs a sort-field write *(measured)* | TRANSFORMS 4, 7 (XB-1's "today" column), 9.2 |
| [limitprobe.mjs](limitprobe.mjs) | `za('s').limit(3)` keeps the old top 3 after a re-rank; where a stray string ranks in `za` and `az`; what `max`, `sum` and `median` give over it | [limitprobe.out](limitprobe.out) *(checked)* | TRANSFORMS 3.1; C7 |
| [data-bugs.mjs](data-bugs.mjs) | the ground study's eleven cases: stale rows in `az`/`za` over a mixed column, ties and `limit` by arrival, float and `NaN` sums that depend on history, `max` over mixed types by arrival, `distinct()` over object rows, a shared `reduce` seed, empty buckets kept by `length(fn)` | [data-bugs.out](data-bugs.out) *(checked)* | TRANSFORMS 2 (row 1), 4, 9.1 (C1 to C5, C9, F1, F2) |
| [top-objects.mjs](top-objects.mjs) | `top(1)` over object rows is whichever row came first | [top-objects.out](top-objects.out) *(checked)* | TRANSFORMS 2 (row 1); C8 |
| [maxprobe.mjs](maxprobe.mjs) | data's `max` and `min` keep any non-null value: the same rows `{a: 5, b: 'x'}` give 5 or `'x'` by arrival order, and `max` over 5, 9, `'42'` is `'42'` | [maxprobe.out](maxprobe.out) *(checked)* | TRANSFORMS 4 (`min`, `max`); C9 |

The untimed outputs here are from a rerun on 2026-11-20 (Node 22.22.0), and they say what the first runs said. `ordcost.jsonl` holds the critic's own three runs; `ordcost.sh` appends three more.

**To rerun.**

```sh
SP=<a scratch folder holding bin/heavy and bin/timing> ./run.sh           # the four untimed probes, each into its .out
SP=... ./run.sh ordcost                                                   # the timed probe, three runs under the timing lock
```

Env: `SP` (required), `NODE` (default `node` on PATH), `DATA` (data's checkout at `63fea66`; the scripts default to `../data`, next to this repo).
