# E-34: waking 10 GB of rows

**Question (Q-34).** Can one Node process wake 10 GB of rows to writable within a minute, with GC pauses under 1 s? "Wake" means: the process starts, reads its snapshot from disk, folds it into `data`, and takes its first committed write. The question decides SC-05 (scale to zero and back: "10 GB is writable again ≤ 1 min after wake"), SC-10's rows per process, F-06 (no false failover from a GC pause ≤ 1 s), F `all` against `ldr`, L `ts` against a native fold, decision 13 (the kernel on a worker thread), and conflict X15 (state past the V8 heap against synchronous reads).

**Threshold (QUESTIONS.md).** ≤ 60 s and a max GC pause < 1 s → F `all` in TS meets SC-05. Otherwise state off the V8 heap (a native fold, LEAN's leader-only fold, or SC-06's cold rows) is planned now, and SC-05's bar is stated per storage form.

## What "10 GB of rows" means here

QUESTIONS.md reads 10 GB as about 5e6 rows, from DEP-13's budget of 2 KB a row. E-05 measured a small row (about 100 B of data) at about 330 B of V8 heap, not 2 KB. So the two readings differ by 6 times, and this experiment runs both:
- **5e6 small rows** (the row count the question names): a 0.64 GB snapshot, about 1.7 GB of heap.
- **5e6 rows of about 2 KB** (the bytes the question names): each small row plus a 1,900-character text field, a **10.2 GB snapshot**, about 11 GB of heap. Its first half (2.5e6 rows, 5.1 GB) is the "5 GB, then scale" case the question allows for the worker form.

A third reading, 10 GB of *small* rows (about 8e7 rows, 26 GB of heap), cannot run on this 16 GB box, and cannot run in one `data` source on any box: data keys a source's rows in a JS `Map`, and V8 caps a `Map` at 2^24 = 16,777,216 entries (measured below).

RESULTS_PLACEHOLDER
