# the state cap of tools/mutants.py, checked on the fixed protocol: with a cap of 20,000
# on `move` (47,457 states) the run must stop near the cap and read "unbounded";
# with the real cap (10x) it must read "holds" with the full 47,457 states.
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import mutants, tlcrun, shutil
d = os.path.join(mutants.WORK, 'capcheck'); os.makedirs(d, exist_ok=True)
shutil.copy(mutants.SRC, os.path.join(d, 'SlotMoveFixed.tla'))
shutil.copy(os.path.join(mutants.ROOT, 'tla', 'SlotMove.tla'), os.path.join(d, 'SlotMove.tla'))
invs = ['Inv1', 'Inv2', 'Inv3', 'Inv4', 'Inv5', 'Inv6', 'Inv8', 'Inv9']
for cap in (20000, 10 * 47457):
    tlcrun.write_model(d, mutants.consts_for('move', calm=False, soft=False), invs, extends='SlotMoveFixed',
                       module='MC', extra_defs=mutants.cap_defs(cap), copy_spec=False)
    mutants.add_cap(d)
    out, secs = tlcrun.tlc(d, workers=1, heavy=False)
    print(cap, mutants.classify(out, cap), round(secs, 1), flush=True)
