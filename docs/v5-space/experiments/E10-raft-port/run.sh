#!/bin/sh
# Re-runs every E-10 result. Run ./fetch.sh first. CPU-bound steps go through the heavy lock.
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
HERE=$(cd "$(dirname "$0")" && pwd); cd "$HERE"
R=$SP/dl/raftsrc/raft
export GOPATH=$SP/dl/e10-go/gopath GOMODCACHE=$SP/dl/e10-go/gopath/pkg/mod GOTOOLCHAIN=go1.26.10 GOFLAGS=-modcacherw GOCACHE=$SP/dl/e10-go/gocache
uname -srm > results/machine.txt; node --version >> results/machine.txt; (cd "$SP/dl/e10-go/raft-c51f010" && go version) >> results/machine.txt; nproc >> results/machine.txt

# (a) The reference: etcd's own Go tests on its datadriven files.
(cd "$SP/dl/e10-go/raft-c51f010" && cat /proc/loadavg && "$SP/bin/heavy" go test -count=1 -v -run 'TestInteraction|TestDataDriven|TestConfChangeDataDriven' ./ ./quorum ./confchange) > "$SP/dl/e10-go/upstream_test.txt" 2>&1
{ echo "# etcd raft c51f010 Go datadriven run (result lines)"; grep -E "^(--- |    --- |ok |PASS|FAIL)" "$SP/dl/e10-go/upstream_test.txt"; } > results/etcd-upstream-go-datadriven.txt

# (a) The port on the same 41 files, unchanged.
node port/test/run_datadriven.ts "$R" --json results/ts-datadriven.json > results/ts-datadriven.txt

# (a) Negative control: three expected outputs corrupted; the runner must fail exactly those.
rm -rf "$SP/e10neg" && mkdir -p "$SP/e10neg/quorum" "$SP/e10neg/confchange"
cp -r "$R/testdata" "$SP/e10neg/"; cp -r "$R/quorum/testdata" "$SP/e10neg/quorum/"; cp -r "$R/confchange/testdata" "$SP/e10neg/confchange/"
sed -i 's/became leader at term 1/became leader at term 9/' "$SP/e10neg/testdata/campaign.txt"
sed -i '0,/VoteWon/s/VoteWon/VoteLost/' "$SP/e10neg/quorum/testdata/majority_vote.txt"
sed -i '0,/StateProbe match=0 next=1/s/next=1/next=2/' "$SP/e10neg/confchange/testdata/zero.txt"
node port/test/run_datadriven.ts "$SP/e10neg" --diff > results/negative-control.txt || true

# (a) The multi-group example (a smoke test, not a benchmark).
node port/test/cluster_smoke.ts 4 2000 > results/cluster-smoke.txt

# (a) Differential fuzz against the Go code: 2 x 1,000 random scripts.
{ cat /proc/loadavg; for s in 2 3; do echo "== seed $s, 1000 scripts"; ./diff/run_diff.sh 1000 $s; done; } > results/diff-fuzz-run1.txt 2>&1

# (a) The same with the two commands etcd's harness lacks: linearizable reads, then reads plus crash-restarts.
{ cat /proc/loadavg; echo "== seed 5, 1000 scripts with read-index"; ./diff/run_diff.sh 1000 5 readindex; } > results/diff-fuzz-run2-readindex.txt 2>&1
{ cat /proc/loadavg; echo "== seed 7, 1000 scripts with read-index and restart"; ./diff/run_diff.sh 1000 7 readindex,restart; cat "$SP"/e10diff/seed7/out/*.panic 2>/dev/null || true; } > results/diff-fuzz-run3-readindex-restart.txt 2>&1

# (a) Mutation runs: how many one-rule changes to the port each oracle catches.
#     Run 1: all 1,147 mutants against the 41 files, then the seed-2 fuzz. Runs 2 and 3: run 1's
#     survivors against the read-index corpus, then run 2's against the read-index + restart corpus.
{ cat /proc/loadavg; date -u; "$SP/bin/heavy" node diff/mutate.ts "$R" "$SP/e10diff/seed2/out" "$SP/e10diff/seed2/in"; date -u; } > results/mutation-run.txt 2>&1
cp results/mutation-run.txt "$SP/e10-mutation-run1.txt"
{ cat /proc/loadavg; date -u; E10_SURVIVORS="$SP/e10-mutation-run1.txt" "$SP/bin/heavy" node diff/mutate.ts "$R" "$SP/e10diff/seed5/out" "$SP/e10diff/seed5/in"; date -u; } > results/mutation-run2-survivors-vs-readindex-fuzz.txt 2>&1
cp results/mutation-run2-survivors-vs-readindex-fuzz.txt "$SP/e10-mutation-run2.txt"
{ cat /proc/loadavg; date -u; E10_SURVIVORS="$SP/e10-mutation-run2.txt" "$SP/bin/heavy" node diff/mutate.ts "$R" "$SP/e10diff/seed7/out" "$SP/e10diff/seed7/in"; date -u; } > results/mutation-run3-survivors-vs-restart-fuzz.txt 2>&1
python3 -I diff/classify_swaps.py results/mutation-run3-survivors-vs-restart-fuzz.txt port/src > results/mutation-swap-classes.txt

# Sizes, raft-rs, upstream churn, npm.
C="python3 -I tools/count_lines.py"
{
  echo "## etcd raft c51f010, non-test Go (physical, non-blank, code)"
  for d in . quorum tracker confchange raftpb rafttest; do echo "### $d"; $C $(ls $R/$d/*.go | grep -v _test.go | grep -v pb.go); done
  echo "### raftpb generated + schema"; $C $R/raftpb/raft.pb.go $R/raftpb/raft.proto
  echo "### Go tests (not ported)"; $C $(ls $R/*_test.go $R/*/*_test.go)
  echo "## TS port"; $C port/src/*.ts; $C port/rafttest/*.ts; $C port/test/*.ts; $C diff/*.ts diff/*.go diff/*.py
} > results/line-counts.txt
RR=$SP/dl/raft-rs/raft-0.7.0
{ echo "## raft-rs 0.7.0 src"; $C $(find $RR/src -name '*.rs' | sort); } > results/raft-rs-line-counts.txt
tools/upstream_churn.sh "$SP/dl/e10-raft-history/raft.git" "$SP/dl/e10-raftrs-history/raft-rs.git" > results/upstream-churn.txt
python3 -I npm/survey.py "$SP/dl/e10-npm" > results/npm-survey.md && cp "$SP/dl/e10-npm/survey.json" results/npm-survey.json
echo done
