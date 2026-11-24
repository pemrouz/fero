# Where these files come from

These are etcd raft's datadriven test files. They are copied unchanged.

- **Source:** https://github.com/etcd-io/raft
- **Commit:** `c51f010c851edd0dada5af41bafbf68e54617767` (2026-10-23)
- **Licence:** Apache-2.0 (see [../LICENSE](../LICENSE))
- **Count:** 41 files (counted).

| Here | In etcd raft | Files |
|---|---|---:|
| `*.txt` | `testdata/` | 28 |
| `quorum/*.txt` | `quorum/testdata/` | 4 |
| `confchange/*.txt` | `confchange/testdata/` | 9 |

Do not edit them. They are the oracle: the port's output must equal the
expected text in each file byte for byte.

## How to check they are still unchanged

`SHA256SUMS` holds the hash of every file, taken from the upstream checkout.

    sh check-upstream.sh                 # checks the files against SHA256SUMS
    sh check-upstream.sh <etcd raft dir> # also compares with an upstream checkout

With a checkout, the script also checks that it is at the commit above (when
it is a git checkout) and that upstream has no file that is missing here.
Both forms end with `ok testdata: 41 files`.
