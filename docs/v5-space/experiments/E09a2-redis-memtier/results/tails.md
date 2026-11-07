## Where memtier's tail sits (from results/persec.jsonl, per run)

"max in s0" = runs whose max latency fell in the first second (the start). Latency in ms.

| config | runs | max in s0 | max (median) | whole-run p99.9 (median) | per-second p99.9, median of the run medians | worst second's p99.9 (median) |
|---|---|---|---|---|---|---|
| default-set-p1 | 3 | 3 | 28.5 | 5.727 | 3.967 | 7.519 |
| default-set-p16 | 3 | 1 | 41.7 | 17.663 | 11.199 | 25.215 |
| default-get-p1 | 3 | 1 | 33.8 | 5.055 | 3.615 | 5.471 |
| default-get-p16 | 3 | 3 | 36.9 | 10.751 | 8.447 | 12.927 |
| default-incr-p1 | 3 | 3 | 28.8 | 5.663 | 4.383 | 8.639 |
| default-incr-p16 | 3 | 3 | 26.9 | 12.735 | 9.663 | 16.511 |
| default-mix-p1 | 3 | 2 | 30.2 | 4.927 | 3.631 | 7.039 |
| default-mix-p16 | 3 | 2 | 39.7 | 13.503 | 9.343 | 22.015 |
| aof-set-p1 | 3 | 0 | 48.9 | 9.535 | 8.447 | 48.383 |
| aof-set-p16 | 3 | 0 | 47.6 | 41.983 | 36.607 | 45.823 |
| aof-get-p1 | 3 | 3 | 26.0 | 5.471 | 3.951 | 6.495 |
| aof-get-p16 | 3 | 3 | 34.6 | 12.543 | 9.983 | 14.015 |
| aof-incr-p1 | 3 | 0 | 43.5 | 8.959 | 6.815 | 40.959 |
| aof-incr-p16 | 3 | 0 | 48.4 | 36.351 | 13.951 | 45.311 |
| aof-mix-p1 | 3 | 1 | 35.3 | 6.431 | 4.831 | 22.655 |
| aof-mix-p16 | 3 | 1 | 44.3 | 26.495 | 11.071 | 43.007 |
| aof-r3-set-p1 | 3 | 0 | 88.6 | 31.743 | 5.631 | 73.215 |
| aof-r3-set-p16 | 3 | 0 | 64.8 | 51.711 | 40.447 | 58.623 |
| aof-r3-incr-p1 | 3 | 0 | 70.1 | 8.575 | 4.831 | 64.767 |
| aof-r3-incr-p16 | 3 | 0 | 72.2 | 44.287 | 15.359 | 68.607 |
| aof-r3-mix-p1 | 3 | 2 | 31.6 | 5.375 | 3.535 | 6.687 |
| aof-r3-mix-p16 | 3 | 0 | 80.4 | 36.607 | 8.447 | 76.799 |
