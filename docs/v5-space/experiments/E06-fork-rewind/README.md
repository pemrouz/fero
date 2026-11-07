# E-06: fork and rewind for fero test

**Question (Q-06).** Can `data` fork and rewind state cheaply enough for fero test? TEST-06 says a fork costs a record, not a copy. TEST-07 says any recorded input can be re-run on the exact state just before it, in ≤ 10 ms each (so 100 reruns take ≤ 1 s; T's spike took about 100 s for 387). The question decides TEST-06 and TEST-07 for every candidate, and whether `data` needs shared-structure state, a data-side change to plan now (DATA-04).

**Threshold (QUESTIONS.md).** A rerun ≤ 10 ms at the café's size (fero test's example) and ≤ 100 ms at 1e6 rows → no data change. Above → data gains structural sharing (planned now), or fero test states its limit.

RESULTS_PLACEHOLDER
