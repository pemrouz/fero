# self-test: real Elle 0.2.8 and Knossos 0.3.16, 2026-11-06T22:07:29Z, openjdk version "21.0.12.1" 2026-08-18, 4 vCPU, load 11.54 6.96 6.45
# Real Elle 0.2.8 on E-22's 8 Elle self-test cases

| case | want rc / sr | port rc / sr | real rc / sr | real anomaly types | must-have found by real | agree |
|---|---|---|---|---|---|---|
| good: serial appends and reads | True / True | True / True | True / True | none | -: True | yes |
| bad G0: two units write x and y in opposite orders | False / False | False / False | False / False | G0 | G0: True | yes |
| bad G1c: each unit reads the other's append | False / False | False / False | False / False | G1c | G1c: True | yes |
| bad G1a: a read sees a failed unit's append | | | ERROR class java.lang.UnsupportedOperationException: count not supported on this type: Boolean | | | no |
| bad G-single: a fractured read (half a unit) | True / False | True / False | True / False | G-single-item | G-single: True | yes |
| bad G2-item: write skew | True / False | True / False | True / False | G2-item | G2-item: True | yes |
| bad: a list that loses an element (incompatible order) | False / False | False / False | False / False | incompatible-order | incompatible-order: True | yes |
| bad: an element appended once, read twice | False / False | False / False | False / False | duplicate-elements | duplicate-elements: True | yes |

7 of 8 cases: real Elle gives the expected verdict and finds the named anomaly.

# Knossos 0.3.16 (E-22's partition model, ported) on E-22's 18 Porcupine self-test cases

| case | want | Porcupine | Knossos | agree |
|---|---|---|---|---|
| good: two overlapping writes, a later read sees the second by version | ok | ok | ok | yes |
| good: a read overlapping a write may see the old value | ok | ok | ok | yes |
| bad: a stale read after a newer write was acknowledged | illegal | illegal | illegal | yes |
| bad: an acknowledged write lost (a later read finds no row) | illegal | illegal | illegal | yes |
| bad: a read with the right version but another value | illegal | illegal | illegal | yes |
| bad: one incr applied twice (answers 1 then 3) | illegal | illegal | illegal | yes |
| good: two concurrent incrs answer 1 and 2 in either order | ok | ok | ok | yes |
| bad: one version given to two writes | illegal | illegal | illegal | yes |
| bad: versions out of real-time order | illegal | illegal | illegal | yes |
| bad: an if-version write refused although the version matched | illegal | illegal | illegal | yes |
| good: an if-version write refused after another write moved the version | ok | ok | ok | yes |
| bad: an if-version write passed on a stale version | illegal | illegal | illegal | yes |
| bad: incr below min 0 acknowledged (stock 0 sold) | illegal | illegal | illegal | yes |
| good: incr below min 0 refused | ok | ok | ok | yes |
| bad: incr refused though the bound held | illegal | illegal | illegal | yes |
| bad: if-absent write passed on a row that exists | illegal | illegal | illegal | yes |
| good: a writer-made ttl removal, then a read finds no row | ok | ok | ok | yes |
| good: a write whose client died, found in the log, seen by a later read | ok | ok | ok | yes |

18 of 18 cases: Knossos, Porcupine and the expected answer agree.
