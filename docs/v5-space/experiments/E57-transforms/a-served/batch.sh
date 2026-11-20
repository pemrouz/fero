#!/bin/sh
# E-57 group A: one batch of processes, run in turn (run.sh runs this whole file under ONE lock hold, so the batch waits
# for the box once, not once per process). Each line of the batch is a process; its load average goes before its line.
#   batch.sh sims|mutants|timing|pagecost|xa2more|xa2mut <out.jsonl> <run> <seeds>
HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
NODEF="$NODE --expose-gc --experimental-strip-types --no-warnings --max-old-space-size=3000"
F=$2; RUN=${3:-1}; SEEDS=${4:-1000}
one() { # dir, env mutate, args...
  dir=$1; m=$2; shift 2
  printf '{"run":%s,"loadavg":"%s","cmd":"%s","mutate":"%s"}\n' "$RUN" "$(cat /proc/loadavg)" "$*" "$m" >> "$F"
  E=${ERRDIR:-$HERE/results}/stderr.txt
  (cd "$HERE/$dir" && E57_MUTATE=$m $NODEF "$@" >> "$F" 2> "$E") || printf '{"exp":"E-57","part":"failed","run":%s,"cmd":"%s","stderr":"%s"}\n' "$RUN" "$*" "$(tail -c 300 "$E" | tr '\n"' '  ')" >> "$F"
}
case "$1" in
  sims)
    for c in a1 a2 a3 a4 a5 a6 a7 a8 xa2 xa8ctl xa9 xa10 xa12 xa13; do one sim "" run.mjs $c $SEEDS; done
    for c in share sharing placement pages; do one sim "" run.mjs $c; done ;;
  mutants)
    for cm in a1:keyedcopy a1:floatsum a2:ownseq a2:noinstance a3:arrival a3:noseenwait a3:copyinst a3:onleader a3:wholesale a3:noorderc a3:keyedright \
              a4:allowonce a4:unsortedkey a5:doubledec a5:nolingercount a6:disposefirst a6:handlerleak a7:keyedcopy a7:picorder a8:nover \
              xa2:noheadroom xa2:freecopy xa9:countonly xa10:tableversion xa12:nosticky xa13:earlysync; do
      one sim "${cm##*:}" run.mjs "${cm%%:*}" $SEEDS
    done
    one sim "" run.mjs xa8 $SEEDS # the impure view is itself the planted bug (its control is xa8ctl in sims)
    for cm in sharing:unsortedkey placement:freecopy placement:noheadroom pages:pageentry; do one sim "${cm##*:}" run.mjs "${cm%%:*}"; done ;;
  timing)
    for n in 1000 10000 100000; do one bench "" copycost.mjs $n; done   # A1
    one bench "" resume.mjs 10000                                     # A2
    for n in 100000 1000000; do one bench "" rebuild.mjs $n; done     # A3, XA-1
    one bench "" joincost.mjs                                         # A4
    for n in 10000 100000; do one bench "" viewmem.mjs $n; done       # A5, XA-7
    for n in 1000 10000; do one bench "" classb.mjs $n; done ;;       # A7
  xa2more) # added after the skeptic's review (F2, F24): the headroom rule, leader kills, one and two standbys
    for c in xa2 xa2l xa2sb xa2sbx xa2s2 xa2s2x; do one sim "" run.mjs $c $SEEDS; done ;;
  xa2mut) # the planted bugs for the headroom rule: the first formula at one serving copy, and no headroom
    for m in fixedhead noheadroom; do one sim "$m" run.mjs xa2sbx $SEEDS; done ;;
  pagecost) # added after the skeptic's review (F1, F23): the shared page index per write, beside best(10)
    for n in 1000 5000 10000 100000; do one bench "" pagecost.mjs $n; done ;;
esac
