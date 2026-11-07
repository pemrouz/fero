#!/bin/sh
# Called by extra.sh inside one heavy hold. See extra.sh.
cd "$(dirname "$0")"
R=../E17-partitioning/results
B="--bound readback --bound readback1 --bound bothread"
for pair in fixN:fixN slot:slot slot:slot-rev slot:slot+abort rekey-carry:rekey-carry \
            pslot:pslot pslot:pslot-rev pslot:pslot+abort pslot-fused:pslot-fused pslot-fused:pslot-fused-rev \
            pslot-fused:pslot-fused+abort split:split split:split-rev split:split+giveup \
            lanes:lanes lanes:lanes-rev lanes-carry:lanes-carry lanes:lanes+abort; do
  o=${pair%%:*}; m=${pair#*:}
  [ -f "$R/$m-ablation.json" ] || { echo "$m: no result yet"; continue; }
  case "$m" in
    # a give-up path makes readback1 pass 1.5 million states (undecided): leave it out
    *+abort|*+giveup) python3 extra.py --option "$o" --minimal "$m" --bound readback --bound bothread --repair ;;
    *) python3 extra.py --option "$o" --minimal "$m" $B --repair ;;
  esac
done
for o in pslot pslot-fused split lanes lanes-carry; do
  python3 extra.py --option "$o" $B
done
# The lanes-atfence probe: lanes' smallest set with the final copy read at the
# fence, and "one final copy" (final.once) dropped too, on every shared bound
# and the three bigger ones; then the same drop on lanes as ablated.
if [ -f "$R/lanes-ablation.json" ]; then
  echo "== lanes-atfence: lanes' smallest set, copy at the fence, without final.once"
  python3 extra.py --option lanes-atfence --minimal lanes --drop final.once \
      --bound grow --bound shrink --bound both --bound read --bound deep --bound twice --bound twice1 $B
  echo "== lanes as ablated: lanes' smallest set without final.once, for comparison"
  python3 extra.py --option lanes --minimal lanes --drop final.once --bound both
fi
# ... and the at-fence probe with "fence a move once" put back, on the bigger bounds
if [ -f "$R/lanes-ablation.json" ]; then
  echo "== lanes-atfence: as above, with fence.once put back"
  python3 extra.py --option lanes-atfence --minimal lanes --drop final.once --keep fence.once \
      --bound readback --bound readback1 --bound bothread --bound both --bound twice1
fi
