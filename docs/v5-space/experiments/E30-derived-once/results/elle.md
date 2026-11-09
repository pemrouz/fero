# E-30: real Elle 0.2.8 on the derived outputs

Each history is one seeded random walk of `models/derived.py` (faults for 40 steps, then calm steps), written by `elle_hist.py` as list-append operations (one append per output, one final read of each B row). `agree` counts histories where Elle reports `:duplicate-elements` exactly when the model's ONCE check is broken. Lost outputs are the model's LOST check; list-append has no check for an acknowledged append that no read shows, so Elle is not asked about them.

| option | bound | histories | model ONCE broken | Elle :duplicate-elements | agree | Elle invalid (rc) | model LOST broken | walk reached B = f(A) | elle error |
|---|---|---|---|---|---|---|---|---|---|
| keys | long | 200 | 39 | 39 | 200 | 39 | 0 | 127 | 0 |
| keys | short | 200 | 0 | 0 | 200 | 0 | 0 | 200 | 0 |
| pid | long | 200 | 139 | 139 | 200 | 139 | 0 | 61 | 0 |
| pid | short | 200 | 135 | 135 | 200 | 135 | 0 | 65 | 0 |
| sess | long | 200 | 40 | 40 | 200 | 40 | 0 | 155 | 0 |
| sess | short | 200 | 0 | 0 | 200 | 0 | 0 | 200 | 0 |
| srchi | long | 200 | 0 | 0 | 200 | 0 | 0 | 200 | 0 |
| srchi | short | 200 | 0 | 0 | 200 | 0 | 0 | 200 | 0 |
| srchi-slot | long | 200 | 0 | 0 | 200 | 0 | 0 | 200 | 0 |
| srchi-slot | short | 200 | 0 | 0 | 200 | 0 | 0 | 200 | 0 |
| srcpos | long | 200 | 0 | 0 | 200 | 0 | 0 | 200 | 0 |
| srcpos | short | 200 | 0 | 0 | 200 | 0 | 0 | 200 | 0 |
| win | long | 200 | 43 | 43 | 200 | 43 | 0 | 115 | 0 |
| win | short | 200 | 0 | 0 | 200 | 0 | 0 | 200 | 0 |

Anomaly types Elle reported (histories, all options): `duplicate-elements` 396.

# run, 2026-11-09T21:42:11Z, Python 3.13.17, 4 vCPU, load 3.93 2.61 2.13
openjdk version "21.0.12.1" 2026-08-18
