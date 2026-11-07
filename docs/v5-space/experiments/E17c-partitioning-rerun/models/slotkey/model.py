"""
slotkey: a probe of how E-17 part 2 counted pslot's four "naming" rules.

pslot's model (options/pslot/model.py) puts p and q in slot 0 of two
resources, P and Q, in one group, and gives every move entry its resource
by its own update (`res`); dropped, the entry names "slot 0" of every
resource in the group. slot's model (options/slot/model.py) puts p and q in
two slots, s and t, of one resource, and builds the slot into each entry's
append: it is never ablated.

This probe is pslot's model, unchanged, with one line different: p and q sit
in slots s and t of ONE resource R. The key is still (first, second); the
first part, the one each entry sets by its own update, is now the SLOT, and
the second part, fixed, is the resource. So this is slot's option, counted
the way part 2 counted pslot: a dropped update leaves an entry that names
no slot, which then applies to every slot of R in the group.

If this probe needs the same four rules, they name the key, not the
resource: slot needs them too, but its model never counted them, and
pslot's "+4" is a counting difference between two models, not a cost of
groups shared across resources.
"""
import importlib.util
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_path = os.path.join(os.path.dirname(_here), 'pslot', 'model.py')
_spec = importlib.util.spec_from_file_location('opt_pslot_for_slotkey', _path)
_mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _mod
_spec.loader.exec_module(_mod)

# the one change: two slots of one resource, the slot being the ablated half
_mod.SLOT.clear()
_mod.SLOT.update({'p': ('s', 'R'), 'q': ('t', 'R')})


class SlotKey(_mod.PSlot):
    pass


OPTION = SlotKey
GIVEUP = _mod.GIVEUP
