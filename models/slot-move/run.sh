#!/bin/sh
# The slot-move models: rerun everything.
#
# Three models.  A bound's name says which one it runs:
#   msg-*   SlotMoveMsg.tla      stored reports, the recovery, the early carried set
#   mem-*   SlotMoveMembers.tla  one group with its members
#   others  SlotMove.tla         the move in full, groups as single logs
#
#   TLA_JAR  the TLA+ tools jar (tla2tools.jar)             required
#   WORK     a scratch folder for TLC's files               default ./target/work
#   HEAVY    an optional wrapper command (a CPU lock)       default none
#   WORKERS  TLC worker threads                             default 2
#   LIMIT    seconds one run may take                       default 3600
#   HEAP     the Java heap                                  default 4g
#   CKPT     minutes between a big bound's checkpoints      default 10
#
#   ./run.sh              the small bounds, the reach checks and the stall checks
#   ./run.sh big          also the big bounds (each under one hour)
#   ./run.sh big NAME...  only the named bounds, for example: big big-all r-hard
#   ./run.sh resume NAME  go on with a big bound from its last checkpoint
#   ./run.sh mutants      plant every mistake of mutants.txt
#   ./run.sh extra        plant every mistake of extra-mutants.txt
#   ./run.sh decided      the decided form's small bounds, reach and stall checks
#   ./run.sh decided big  also the decided form's big bounds
#   ./run.sh decided-mutants  plant every mistake of decided-mutants.txt
#
# The decided form is the move as the owner decided it on card 0002: one
# commit in the window (OneCommit = TRUE) and the source's reopen not waiting
# for the row (BackFirst = FALSE).  Its bounds are named d-*, msg-d-* and
# mem-d-*; each is an older bound's world with those two switches set.
#
# A safety bound must end "pass".  A reach bound must end "violated": its
# check says "the goal is never reached", so a failure shows the goal is.
# A stall bound must end "none" or "stall", as listed.
#
# A big bound writes a checkpoint every 10 minutes into a folder under
# WORK/<name>/meta.
# If the run is stopped (a pause, a restart, the time limit), "resume NAME"
# goes on from the last checkpoint with TLC's -recover.  Keep WORK on a disk
# that outlives the stop.  Every run uses the same fingerprint function
# (-fp 31): TLC picks one at random otherwise, and a resumed run that picks
# another one counts states again that the first part had already seen.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
: "${TLA_JAR:?set TLA_JAR to the path of tla2tools.jar}"
WORK=${WORK:-./target/work}
mkdir -p "$WORK"; WORK=$(cd "$WORK" && pwd)
WORKERS=${WORKERS:-2}
LIMIT=${LIMIT:-3600}
HEAP=${HEAP:-4g}
CKPT=${CKPT:-10}
export TLA_JAR WORK WORKERS LIMIT

if [ "${1:-}" = "mutants" ]; then
  shift; exec python3 "$HERE/mutate.py" "$@"
fi
if [ "${1:-}" = "extra" ]; then
  shift; exec python3 "$HERE/extra.py" "$@"
fi
if [ "${1:-}" = "decided-mutants" ]; then
  shift; exec python3 "$HERE/decided.py" "$@"
fi

SMALL="core:pass crash:pass bulk:pass twice:pass lock:pass ver:pass ver2:pass lazy:pass down:pass
r-moved:violated r-back:violated r-twice:violated r-hard:violated
s-strict:stall s-lazy:none s-twice:none
msg-core:pass msg-early:pass msg-crash:pass msg-rec:pass msg-rec-early:pass msg-rec-crash:pass
msg-rec-down:pass msg-rec-twice:pass msg-rec-lazy:pass msg-rec-three:pass msg-rec2:pass
msg-r-early:violated msg-r-lostback:violated msg-r-reopen:violated msg-r-oldreport:violated
msg-r-aftersrc:violated msg-r-afterdst:violated
mem-src-core:pass mem-dst-core:pass mem-dst-grow:pass mem-dst-shrink:pass mem-src-fault:pass
mem-dst-fault:pass mem-src-cfg:pass mem-src-cfg2:pass mem-src-r:violated mem-dst-r:violated"
BIG="big-all:pass big-faults:pass big-two:pass big-lock:pass big-ver:pass big-streams:pass
big-three:pass big-lazy:pass
msg-big-rec:pass msg-big-three:pass msg-big-early:pass msg-big-all:pass msg-deep-all:pass
mem-src-two:pass mem-dst-two:pass mem-r-two:violated"
# Bounds added by a second reading: faults and events side by side that the
# bounds above did not have together.  Run with "big", or by name.
MORE="x-ver-copy:pass x-lock-ver:pass x-lazy-ver:pass
msg-x-lazy-down:pass msg-x-rec2-early:pass msg-x-rec2-down:pass msg-x-s2n2:pass msg-r-twice:violated
mem-x-src-pcrash:pass mem-x-dst-pcrash:pass mem-x-dst-grow-fault:pass mem-x-src-n2:pass
mem-x-src-cfg2-fault:pass mem-x-src-add-term:pass mem-r-back:violated"
# The decided form (card 0002).  The same worlds as the bounds above, with
# OneCommit = TRUE and BackFirst = FALSE.  Left out because they would repeat
# a world: big-lazy (it is d-big-all), msg-rec-lazy (msg-d-rec-twice), s-strict
# (d-s-lazy), mem-src-cfg2 (it has no writes, so the switch changes nothing).
# The stall checks must find no stall: no slot waits for the home group.
DSMALL="d-core:pass d-crash:pass d-bulk:pass d-twice:pass d-lock:pass d-ver:pass d-ver2:pass d-lazy:pass d-down:pass
d-r-moved:violated d-r-back:violated d-r-twice:violated d-r-hard:violated
d-s-lazy:none d-s-twice:none
msg-d-core:pass msg-d-early:pass msg-d-crash:pass msg-d-rec:pass msg-d-rec-early:pass msg-d-rec-crash:pass
msg-d-rec-down:pass msg-d-rec-twice:pass msg-d-rec-three:pass msg-d-rec2:pass
msg-d-r-early:violated msg-d-r-lostback:violated msg-d-r-reopen:violated msg-d-r-oldreport:violated
msg-d-r-aftersrc:violated msg-d-r-afterdst:violated msg-d-r-twice:violated
mem-d-src-core:pass mem-d-dst-core:pass mem-d-dst-grow:pass mem-d-dst-shrink:pass mem-d-src-fault:pass
mem-d-dst-fault:pass mem-d-src-cfg:pass mem-d-src-r:violated mem-d-dst-r:violated mem-d-r-back:violated"
DBIG="d-big-all:pass d-big-faults:pass d-big-two:pass d-big-lock:pass d-big-ver:pass d-big-streams:pass
d-big-three:pass d-x-ver-copy:pass d-x-lock-ver:pass d-x-lazy-ver:pass
msg-d-big-rec:pass msg-d-big-three:pass msg-d-big-early:pass msg-d-big-all:pass msg-d-deep-all:pass
msg-d-x-lazy-down:pass msg-d-x-s2n2:pass msg-d-x-rec2-down:pass msg-d-x-rec2-early:pass
mem-d-src-two:pass mem-d-dst-two:pass mem-d-r-two:violated
mem-d-x-src-pcrash:pass mem-d-x-dst-pcrash:pass mem-d-x-dst-grow-fault:pass mem-d-x-src-n2:pass
mem-d-x-src-cfg2-fault:pass mem-d-x-src-add-term:pass"
# Not run by default: bounds that did not finish in an hour here.  Name one
# after "big" to try it:  ./run.sh big deep-faults
DEEP="deep-faults:pass mem-deep-four:pass mem-x-src-add-fault:pass"
LIST=$SMALL
RECOVER=""
if [ "${1:-}" = "decided" ]; then
  LIST=$DSMALL; shift
  if [ "${1:-}" = "big" ]; then LIST="$DSMALL $DBIG"; shift; fi
fi
if [ "${1:-}" = "big" ]; then LIST="$SMALL $BIG $MORE $DSMALL $DBIG"; shift; fi
if [ "${1:-}" = "resume" ]; then LIST="$SMALL $BIG $MORE $DSMALL $DBIG"; RECOVER=yes; shift; fi
if [ $# -gt 0 ]; then
  PICK=""
  for item in $SMALL $BIG $MORE $DEEP $DSMALL $DBIG; do
    cfg=${item%%:*}
    for name in "$@"; do [ "$name" = "$cfg" ] && PICK="$PICK $item"; done
  done
  LIST=$PICK
fi

# run one command with a time limit that kills its whole process group
limited() {
  if command -v setsid >/dev/null 2>&1; then setsid timeout --kill-after=10 "$LIMIT" "$@"
  else timeout --kill-after=10 "$LIMIT" "$@"; fi
}

bad=0
for item in $LIST; do
  cfg=${item%%:*}; want=${item#*:}
  dir="$WORK/$cfg"
  t0=$(date +%s)
  case $cfg in
  s-*|d-s-*)
    rm -rf "$dir"; mkdir -p "$dir"
    (cd "$HERE" && limited ${HEAVY:-} java -Xmx"$HEAP" -XX:+UseParallelGC \
        -cp "$TLA_JAR" tlc2.TLC -noGenerateSpecTE -workers 1 -metadir "$dir/meta" \
        -dump dot,actionlabels "$dir/graph.dot" \
        -config "$cfg.cfg" SlotMoveStall.tla) > "$dir/out.txt" 2>&1
    python3 "$HERE/stall.py" "$dir/graph.dot" "$dir/stall.json" > "$dir/stall.txt" 2>&1
    if grep -q "^stall: none" "$dir/stall.txt"; then got=none
    elif grep -q "^stall: FOUND" "$dir/stall.txt"; then got=stall
    else got=error; fi
    extra=$(grep "stuck of" "$dir/stall.txt" | sed -E 's/^.*: ([0-9]+ stuck of [0-9]+)$/\1/' | tr '\n' ',' | sed 's/,$//')
    rm -f "$dir/graph.dot"
    ;;
  *)
    more=""
    case $cfg in big-*|deep-*|x-*|msg-big-*|msg-deep-*|msg-x-*|mem-*-two|mem-deep-*|mem-x-*|d-big-*|d-x-*|msg-d-big-*|msg-d-deep-*|msg-d-x-*|mem-d-x-*) more="-checkpoint $CKPT";; esac
    module=SlotMove
    case $cfg in msg-*) module=SlotMoveMsg;; mem-*) module=SlotMoveMembers;; esac
    ck=""
    [ -n "$RECOVER" ] && ck=$(ls -d "$dir"/meta/*/ 2>/dev/null | tail -n 1)
    if [ -n "$ck" ]; then more="$more -recover $ck"; echo "resuming $cfg from $ck" >> "$dir/out.txt"
    else rm -rf "$dir"; mkdir -p "$dir"; fi
    (cd "$HERE" && limited ${HEAVY:-} java -Xmx"$HEAP" -XX:+UseParallelGC \
        -cp "$TLA_JAR" tlc2.TLC -noGenerateSpecTE -fp 31 -workers "$WORKERS" -metadir "$dir/meta" \
        $more -config "$cfg.cfg" "$module.tla") >> "$dir/out.txt" 2>&1
    if grep -q "No error has been found" "$dir/out.txt"; then got=pass
    elif grep -q "is violated" "$dir/out.txt"; then got=violated
    else got=error; fi
    extra=""
    ;;
  esac
  t1=$(date +%s)
  states=$(grep -E "states generated, .* distinct" "$dir/out.txt" | tail -n 1 |
           sed -E 's/ states generated, / generated, /; s/ distinct states found.*/ distinct/')
  depth=$(grep -E "^The depth" "$dir/out.txt" | tail -n 1 | sed -E 's/[^0-9]//g')
  mark=ok; [ "$got" = "$want" ] || { mark=WRONG; bad=1; }
  echo "$mark $cfg: $got (want $want); $states; depth $depth; ${extra:+$extra; }$((t1 - t0)) s"
  # a finished run needs no checkpoint; an unfinished one keeps it for "resume"
  [ "$got" = error ] || rm -rf "$dir/meta"
done
[ $bad = 0 ] && echo "ok slot-move" || { echo "FAILED slot-move"; exit 1; }
