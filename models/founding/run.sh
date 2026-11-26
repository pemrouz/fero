#!/bin/sh
# Founding with several groups: rerun every model.
#
#   TLA_JAR  the TLA+ tools jar (tla2tools.jar)             required
#   WORK     a scratch folder for TLC's files               default ./target/work
#   HEAVY    an optional wrapper command (a CPU lock)       default none
#   WORKERS  TLC worker threads                             default 2
#   LIMIT    seconds one run may take                       default 3600
#   EVERY    minutes between a big bound's checkpoints      default 10
#
#   ./run.sh              the small bounds, the reach checks, the probes
#   ./run.sh big          also the big bounds (each under one hour)
#   ./run.sh big NAME...  only the named bounds, for example: big s-big c-reach
#   ./run.sh resume NAME  go on with a big bound from its last checkpoint
#   ./run.sh mutants      plant every mistake of mutants.txt
#
# Each line names a model, a bound and what the run must end as:
#   pass      no property fails
#   violated  a reach check ("the goal is never reached") fails, so the goal
#             is reached; or a probe fails, as its note in the README says
#   live      the "always can finish" check holds (TLC, then agef.py)
#
# A big bound runs with a checkpoint every EVERY minutes.  If it is stopped,
# "./run.sh resume NAME" goes on from the last checkpoint under $WORK/NAME.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
: "${TLA_JAR:?set TLA_JAR to the path of tla2tools.jar}"
WORK=${WORK:-./target/work}
mkdir -p "$WORK"; WORK=$(cd "$WORK" && pwd)
WORKERS=${WORKERS:-2}
LIMIT=${LIMIT:-3600}
export TLA_JAR WORK WORKERS LIMIT

if [ "${1:-}" = "mutants" ]; then
  shift; exec python3 "$HERE/mutate.py" "$@"
fi

SMALL="Settings:s-small:pass Settings:s-two:pass Settings:s-alter2:pass
Settings:s-reach:violated Settings:s-reach-ro:violated Settings:s-reach-behind:violated Settings:s-live:live
HomeRecords:h-small:pass HomeRecords:h-foreign:pass HomeRecords:h-pre:pass
HomeRecords:h-reach:violated HomeRecords:h-reach-far:violated HomeRecords:h-reach-other:violated
HomeRecords:h-live:live
Found:f-small:pass Found:f-crash:pass Found:f-crash2:pass Found:f-homefirst:pass Found:f-four:pass
Found:f-quiet:pass Found:f-quiet-crash:pass Found:f-quiet-load:violated
Found:f-reach:violated Found:f-reach-spread:violated Found:f-live:live
Selection:c-small:pass Selection:c-move:pass Selection:c-down:pass Selection:c-both:pass
Selection:c-down2:pass Selection:c-back:pass Selection:c-back-drop:pass
Selection:c-reach:violated Selection:c-back-reach:violated Selection:c-live:live Selection:c-back-live:live"
# Probes: each must FAIL, and the README says what the failure shows.
PROBES="Settings:s-early:violated Found:f-aswritten:violated Found:f-onebox:violated
Found:f-many:violated Selection:c-asread:violated"
BIG="Settings:s-big:pass HomeRecords:h-two:pass HomeRecords:h-big:pass HomeRecords:h-down2:pass
Found:f-big:pass Found:f-load:pass Selection:c-big:pass Selection:c-back-down:pass"

RESUME=""
LIST="$SMALL $PROBES"
if [ "${1:-}" = "big" ]; then LIST="$SMALL $PROBES $BIG"; shift; fi
if [ "${1:-}" = "resume" ]; then RESUME=yes; LIST="$BIG"; shift; fi
if [ $# -gt 0 ]; then
  PICK=""
  for item in $LIST; do
    rest=${item#*:}; cfg=${rest%%:*}
    for name in "$@"; do [ "$name" = "$cfg" ] && PICK="$PICK $item"; done
  done
  LIST=$PICK
fi

bad=0
for item in $LIST; do
  mod=${item%%:*}; rest=${item#*:}; cfg=${rest%%:*}; want=${rest#*:}
  dir="$WORK/$cfg"
  more=""
  # A resumed run must hash states as the stopped run did, so a big bound
  # pins TLC's fingerprint function and seed.
  case " $BIG " in *":$cfg:"*) more="-checkpoint ${EVERY:-10} -fp 1 -seed 1";; esac
  if [ -n "$RESUME" ]; then
    last=$(ls -d "$dir"/meta/*/ 2>/dev/null | tail -n 1)
    [ -n "$last" ] || { echo "no checkpoint for $cfg under $dir/meta"; bad=1; continue; }
    more="$more -recover ${last%/}"
  else
    rm -rf "$dir"; mkdir -p "$dir"
  fi
  tla="$mod.tla"
  if [ "$want" = live ]; then tla="${mod}Live.tla"; more="$more -dump dot $dir/graph.dot"; fi
  t0=$(date +%s)
  # timeout kills the whole process group when the limit passes.
  (cd "$HERE" && timeout -k 10 "$LIMIT" ${HEAVY:-} java -Xmx4g -XX:+UseParallelGC \
      -cp "$TLA_JAR" tlc2.TLC -noGenerateSpecTE -workers "$WORKERS" -metadir "$dir/meta" $more \
      -config "$cfg.cfg" "$tla") > "$dir/out.txt" 2>&1
  t1=$(date +%s)
  if grep -q "No error has been found" "$dir/out.txt"; then got=pass
  elif grep -q "is violated" "$dir/out.txt"; then got=violated
  else got=error; fi
  note=""
  if [ "$want" = live ] && [ "$got" = pass ]; then
    if note=$(python3 "$HERE/agef.py" "$dir/graph.dot" | head -n 1); then got=live; else got=stuck; fi
    note="; $note"
  fi
  rm -f "$dir/graph.dot"
  inv=$(grep -m 1 -E "Invariant [A-Za-z]+ is violated" "$dir/out.txt" | sed -E 's/.*Invariant ([A-Za-z]+) is violated.*/\1/')
  [ -n "$inv" ] && note="$note; $inv fails"
  states=$(grep -E "states generated, .* distinct" "$dir/out.txt" | tail -n 1 |
           sed -E 's/ states generated, / generated, /; s/ distinct states found.*/ distinct/')
  depth=$(grep -E "^The depth" "$dir/out.txt" | sed -E 's/[^0-9]//g')
  mark=ok; [ "$got" = "$want" ] || { mark=WRONG; bad=1; }
  echo "$mark $mod $cfg: $got (want $want); $states; depth $depth; $((t1 - t0)) s$note"
  [ "$got" = "$want" ] && rm -rf "$dir/meta"
done
[ $bad = 0 ] && echo "ok founding" || { echo "FAILED founding"; exit 1; }
