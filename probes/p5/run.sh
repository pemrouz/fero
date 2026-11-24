#!/bin/sh
# Probe P5: rerun every model.
#
#   TLA_JAR  the TLA+ tools jar (tla2tools.jar)             required
#   WORK     a scratch folder for TLC's files               default ./target/work
#   HEAVY    an optional wrapper command (a CPU lock)       default none
#   WORKERS  TLC worker threads                             default 2
#   LIMIT    seconds one run may take                       default 3600
#
#   ./run.sh              the small bounds and the reach checks
#   ./run.sh big          also the big bounds (each under one hour)
#   ./run.sh big NAME...  only the named bounds, for example: big d-move reach
#   ./run.sh mutants      plant every mistake of mutants.txt
#
# A safety bound must end "pass". A reach bound must end "violated": its
# check says "the goal is never reached", so a failure shows the goal is.
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

SMALL="OneNumber:movedoor:pass OneNumber:move:pass OneNumber:restart:pass OneNumber:lapse:pass
OneNumber:door:pass OneNumber:lost:pass OneNumber:all:pass
OneNumber:retrylife:pass OneNumber:back-restart:pass OneNumber:back-lapse:pass OneNumber:back-mix:pass
OneNumber:reach:violated OneNumber:reachdoor:violated
OneNumberDerived:d-small:pass OneNumberDerived:d-crash:pass
OneNumberDerived:d-move:pass OneNumberDerived:d-back:pass OneNumberDerived:d-reach:violated"
BIG="OneNumber:big-door:pass OneNumber:big-movedoor:pass OneNumber:big-move:pass
OneNumberDerived:d-lives:pass OneNumber:big-lost:pass OneNumber:big-restart:pass
OneNumber:big-moveretry:pass"
LIST=$SMALL
if [ "${1:-}" = "big" ]; then LIST="$SMALL $BIG"; shift; fi
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
  dir="$WORK/$cfg"; rm -rf "$dir"; mkdir -p "$dir"
  t0=$(date +%s)
  (cd "$HERE" && timeout "$LIMIT" ${HEAVY:-} java -Xmx3g -XX:+UseParallelGC \
      -cp "$TLA_JAR" tlc2.TLC -noGenerateSpecTE -workers "$WORKERS" -metadir "$dir/meta" \
      -config "$cfg.cfg" "$mod.tla") > "$dir/out.txt" 2>&1
  t1=$(date +%s)
  if grep -q "No error has been found" "$dir/out.txt"; then got=pass
  elif grep -q "is violated" "$dir/out.txt"; then got=violated
  else got=error; fi
  states=$(grep -E "states generated, .* distinct" "$dir/out.txt" | tail -n 1 |
           sed -E 's/ states generated, / generated, /; s/ distinct states found.*/ distinct/')
  depth=$(grep -E "^The depth" "$dir/out.txt" | sed -E 's/[^0-9]//g')
  mark=ok; [ "$got" = "$want" ] || { mark=WRONG; bad=1; }
  echo "$mark $mod $cfg: $got (want $want); $states; depth $depth; $((t1 - t0)) s"
  rm -rf "$dir/meta"
done
[ $bad = 0 ] && echo "ok p5" || { echo "FAILED p5"; exit 1; }
