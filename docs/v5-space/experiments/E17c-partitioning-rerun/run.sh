#!/bin/sh
# E-17 part 3: the independent re-run of every E-17 ablation (parts 1 and 2),
# from scratch, on a fresh copy of the shared harness and models, with fresh
# checkpoints. Nothing in ../E17-partitioning is changed or read back except
# the source files it copies and the original results compare.py reads.
#
#   ./run.sh            # every phase: cores, orders, give-ups, then extras and compare
#   ./run.sh cheap      # fixN, split (all variants), pslot-fused (all variants)
#   ./run.sh cores      # slot, rekey, rekey-carry, lanes, lanes-carry, pslot (with mutants)
#   ./run.sh variants   # the counting probes in models/ (slotkey, slotprobe-trig, slotprobe-atfence)
#   ./run.sh orders     # the other greedy orders (-rev, -alt)
#   ./run.sh giveups    # the give-up prices (+giveup, +abort, +giveup-alt)
#   ./run.sh extra      # the bigger bounds and the hunt (hunt.py), on this re-run's sets
#   ./run.sh compare    # results/compare.md: this re-run against the originals
#
# Each ablation runs in pieces of 20 minutes under the study's heavy lock, two
# worker processes, as parts 1 and 2 did. A piece that runs out of time
# leaves a checkpoint in $WORK/results (a cache, never a result) and the next
# piece carries on. A run whose ablation file already exists is skipped, so
# the script can be started again after a restart. FRESH=1 wipes $WORK.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$HERE/../E17-partitioning" && pwd)
SP=/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad
WORK=${WORK:-$SP/e17c/work}
HEAVY=${HEAVY:-$SP/bin/heavy}
[ -x "$HEAVY" ] || HEAVY=
JOBS=${JOBS:-2}
PHASES=${*:-cheap cores variants orders giveups extra compare}

[ -n "$FRESH" ] && rm -rf "$WORK"
if [ ! -d "$WORK/harness" ]; then
  mkdir -p "$WORK/results"
  (cd "$SRC" && tar cf - --exclude=__pycache__ harness options) | (cd "$WORK" && tar xf -)
fi
# the copy must be byte-identical to the models parts 1 and 2 reported on
(cd "$SRC" && sha256sum harness/*.py options/*/*.py) > "$HERE/results/sources.sha256"
(cd "$WORK" && sha256sum -c --quiet "$HERE/results/sources.sha256")
{ uname -srm; python3 --version; nproc; free -g | sed -n 2p; date -u; cat /proc/loadavg; } >> "$HERE/results/machine.txt"

piece() {   # piece <option> [args]: run until done, one heavy hold per piece
  until (cd "$WORK" && $HEAVY python3 harness/cli.py --option "$@" --ablate --jobs "$JOBS" --budget 1200); do
    rc=$?
    [ "$rc" -eq 3 ] || exit "$rc"
  done
}
run() {     # run <result name> <option> [args]: skip if the result exists
  name=$1; shift
  if [ -f "$WORK/results/$name-ablation.json" ]; then echo "skip $name (done)"; return; fi
  t0=$(date +%s)
  echo "== $name: $* ($(date -u +%H:%M:%S), load $(cut -d' ' -f1-3 /proc/loadavg))"
  piece "$@"
  echo "$name $(( $(date +%s) - t0 )) s wall" >> "$HERE/results/walltime.txt"
}

# The warm-start lists, exactly as parts 1 and 2 used them.
GU="--warm-keep open.noabort --warm-keep abort.imp --warm-keep abort.noopen --warm-keep unfence.abcom \
    --warm-keep unfence.fen --warm-keep unfence.append --warm-keep abort.res --warm-keep unfence.res \
    --warm-drop export.nofence"

for ph in $PHASES; do
  case "$ph" in
    cheap)
      run fixN fixN
      run split split
      run split-rev split --reverse --tag split-rev --seed-from split --no-mutants
      run split+giveup split --giveup --seed-from split --no-mutants
      run pslot-fused pslot-fused
      run pslot-fused-rev pslot-fused --reverse --tag pslot-fused-rev --seed-from pslot-fused --no-mutants
      run pslot-fused+abort pslot-fused --pin abort.append --tag pslot-fused+abort --seed-from pslot-fused --no-mutants ;;
    cores)
      run slot slot
      run rekey rekey
      run rekey-carry rekey-carry --warm-from rekey
      run lanes lanes
      run lanes-carry lanes-carry --warm-from lanes
      run pslot pslot ;;
    orders)
      run slot-rev slot --reverse --tag slot-rev --seed-from slot --no-mutants
      run rekey-alt rekey --warm-from rekey --warm-keep freeze.rkcom --warm-drop freeze.cutcom \
          --warm-drop cut.append --tag rekey-alt --seed-from rekey
      run rekey-carry-alt rekey-carry --warm-from rekey-alt --tag rekey-carry-alt --seed-from rekey-carry
      run rekey-rev rekey --reverse --tag rekey-rev --seed-from rekey --no-mutants
      run rekey-carry-rev rekey-carry --reverse --warm-from rekey-rev --tag rekey-carry-rev \
          --seed-from rekey-carry --no-mutants
      run lanes-rev lanes --reverse --tag lanes-rev --seed-from lanes --no-mutants
      run pslot-rev pslot --reverse --tag pslot-rev --seed-from pslot --no-mutants ;;
    giveups)
      run slot+giveup slot --giveup
      run slot+abort slot --pin abort.append --pin import.append --tag slot+abort --seed-from slot --no-mutants \
          --warm-from slot+giveup --warm-drop cancel.append --warm-drop cancel.nofence \
          --warm-drop fence.nocancel --warm-drop drop.cancom --warm-drop drop.append
      run rekey+giveup rekey --giveup --no-mutants
      run rekey+giveup-alt rekey --giveup --no-mutants --warm-from rekey+giveup --warm-drop cut.ready \
          --warm-drop copy.append --warm-drop copy.once --tag rekey+giveup-alt --seed-from rekey
      run rekey-carry+giveup rekey-carry --giveup --no-mutants --warm-from rekey+giveup-alt \
          --tag rekey-carry+giveup --seed-from rekey-carry
      # shellcheck disable=SC2086
      run pslot+abort pslot --pin abort.append --pin import.append --tag pslot+abort --seed-from pslot \
          --no-mutants --warm-from pslot $GU
      # shellcheck disable=SC2086
      run lanes+abort lanes --pin abort.append --pin import.append --tag lanes+abort --seed-from lanes \
          --no-mutants --warm-from lanes $GU --warm-keep fence.once ;;
    variants)
      # The probes of how a rule is counted (models/): a second harness root
      # holding the same harness and options plus the probes, so the shared
      # copy stays byte-identical. Each starts warm from this re-run's set.
      VAR=$SP/e17c/variants
      rm -rf "$VAR"; mkdir -p "$VAR/results"
      (cd "$WORK" && tar cf - harness options) | (cd "$VAR" && tar xf -)
      cp -r "$HERE/models/." "$VAR/options/"
      cp "$WORK/results/pslot-ablation.json" "$WORK/results/slot-ablation.json" "$VAR/results/"
      W0=$WORK; WORK=$VAR
      run slotkey slotkey --warm-from pslot --no-mutants
      run slotprobe-trig slotprobe-trig --warm-from slot --no-mutants
      run slotprobe-atfence slotprobe-atfence --warm-from slot --warm-drop final.once --no-mutants
      WORK=$W0
      for n in slotkey slotprobe-trig slotprobe-atfence; do
        cp "$VAR/results/$n-ablation.json" "$HERE/results/$n-ablation.json"
      done ;;
    extra)
      (cd "$HERE" && $HEAVY python3 hunt.py --work "$WORK" all > results/hunt.txt) ;;
    compare)
      python3 "$HERE/compare.py" --work "$WORK" > "$HERE/results/compare.md"
      echo "wrote results/compare.md" ;;
  esac
done
