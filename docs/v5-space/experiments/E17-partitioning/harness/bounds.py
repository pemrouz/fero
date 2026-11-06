"""
bounds.py: the shared bounds. Every option runs on the same ones.

A bound gives:
  layouts   the partition -> group layout at the start, then after each scale
            change. Group numbers here are SLOTS OF LOAD, not real groups: an
            option maps them to its own groups. Partition hash: p -> 1, q -> 0,
            so "group = hash mod count" reproduces every layout below, which
            lets fixN and re-key read a layout as a group count.
  attempts  client attempts: (id, partition, lock token). A copy of any
            attempt may reach any group at any time, any number of times.
  crashes   leader crashes allowed per group (each may lose any part of the
            uncommitted tail; a lost tail may come back until the next commit)
  faults    leader crashes allowed per run, over all groups
  reader    whether one reader follows p with a cursor

fixN has no scale change: it runs each bound with the first layout only.
"""

HASH = {'p': 1, 'q': 0}

GROW = [{'p': 0, 'q': 0}, {'p': 1, 'q': 0}]
SHRINK = [{'p': 1, 'q': 0}, {'p': 0, 'q': 0}]
TWICE = [{'p': 0, 'q': 0}, {'p': 1, 'q': 0}, {'p': 0, 'q': 0}]

BOUNDS = {
    # one grow, two writes to the moving partition with rising tokens
    'grow': dict(layouts=GROW, attempts=[('w1', 'p', 1), ('w2', 'p', 2)],
                 crashes=1, faults=2, reader=False),
    # one shrink, the same writes
    'shrink': dict(layouts=SHRINK, attempts=[('w1', 'p', 1), ('w2', 'p', 2)],
                   crashes=1, faults=2, reader=False),
    # one grow with the reader on p; the two writes share a lock token (one
    # holder writing twice), which tells >= from > in the token checks
    'read': dict(layouts=GROW, attempts=[('w1', 'p', 1), ('w2', 'p', 1)],
                 crashes=1, faults=2, reader=True),
    # one grow, one write to each partition (q stays put under slots, moves
    # under re-key)
    'both': dict(layouts=GROW, attempts=[('w1', 'p', 1), ('w3', 'q', 1)],
                 crashes=1, faults=2, reader=False),
    # grow then shrink back, no crash: a second change after the first, stale
    # facts of an ended change, the reader across both changes
    'twice': dict(layouts=TWICE, attempts=[('w1', 'p', 1)],
                  crashes=0, faults=0, reader=True),
    # grow then shrink back with one crash anywhere, no reader. Too big to
    # sweep for re-key (about 1.3 million states), so it only VERIFIES each
    # option's smallest model (runner.py, VERIFY).
    'twice1': dict(layouts=TWICE, attempts=[('w1', 'p', 1)],
                   crashes=1, faults=1, reader=False),
    # one grow, two crashes in one group allowed (a lost tail that comes back)
    'deep': dict(layouts=GROW, attempts=[('w1', 'p', 1), ('w2', 'p', 2)],
                 crashes=2, faults=2, reader=False),
}

# The bounds every ablation and mutant runs on, cheapest first.
SWEEP = ('grow', 'shrink', 'both', 'read', 'deep', 'twice')
# Bounds run on the smallest model only (and on the mutants no SWEEP bound
# catches); a failure there puts dropped rules back.
VERIFY = ('twice1',)


def count(layout):
    return max(layout.values()) + 1


def check_layouts():
    for name, b in BOUNDS.items():
        for lay in b['layouts']:
            n = count(lay)
            for part, g in lay.items():
                assert HASH[part] % n == g, (name, lay)


check_layouts()
