#!/usr/bin/env python3
"""The stall check: from every state, can the writes still finish?

Reads the state graph TLC printed for SlotMoveStall (-dump dot,actionlabels)
and asks, for every reachable state where both data groups have a majority:
is there a path of CALM steps to a state where every write has committed?
A calm step is a step of the protocol; a fault is not.  So a group that is
down stays down, and the question for the states with the home group down
is: can the slot be written again without the home group?

For the states with the home group up it also asks for a state where every
write has committed AND the slot table names the group that serves.

Usage: stall.py graph.dot [out.json]
"""
import json, re, sys
from collections import defaultdict, deque

FAULTS = {"Crash", "Revive", "Down", "Up", "Reconf", "StaleRoute"}

def load(path):
    obs, edges, init = {}, defaultdict(list), None
    node = re.compile(r'^(-?\d+) \[label="(.*)"')
    edge = re.compile(r'^(-?\d+) -> (-?\d+) \[label="S_(\w+)')
    ob = re.compile(r'obs = <<(\w+), (\w+), (\w+), (\w+)>>')
    labels = {}
    with open(path) as f:
        for line in f:
            m = edge.match(line)
            if m:
                edges[m.group(1)].append((m.group(2), m.group(3)))
                continue
            m = node.match(line)
            if m:
                o = ob.search(m.group(2))
                obs[m.group(1)] = tuple(x == "TRUE" for x in o.groups())
                labels[m.group(1)] = m.group(2)
                if init is None:
                    init = m.group(1)
    return obs, edges, labels, init

def can_reach(obs, edges, goal):
    """The states from which a goal state is reachable by calm steps."""
    back = defaultdict(list)
    for a, outs in edges.items():
        for b, act in outs:
            if act not in FAULTS:
                back[b].append(a)
    seen = {s for s in obs if goal(obs[s])}
    todo = deque(seen)
    while todo:
        b = todo.popleft()
        for a in back[b]:
            if a not in seen:
                seen.add(a); todo.append(a)
    return seen

def depths(edges, init):
    prev, todo = {init: None}, deque([init])
    while todo:
        a = todo.popleft()
        for b, act in edges[a]:
            if b not in prev:
                prev[b] = (a, act); todo.append(b)
    return prev

def path_to(prev, target):
    steps, s = [], target
    while prev[s]:
        steps.append(prev[s][1]); s = prev[s][0]
    return steps[::-1]

def main():
    obs, edges, labels, init = load(sys.argv[1])
    acts = sorted({act for outs in edges.values() for _, act in outs})
    writes = can_reach(obs, edges, lambda o: o[0])
    table = can_reach(obs, edges, lambda o: o[0] and o[3])
    live = [s for s in obs if obs[s][1]]
    prev = depths(edges, init)
    rows = {}
    for name, pick, ok in (
        ("home up: the writes can finish", lambda o: o[2], writes),
        ("home up: and the table names the server", lambda o: o[2], table),
        ("home down: the writes can finish without it", lambda o: not o[2], writes)):
        part = [s for s in live if pick(obs[s])]
        bad = [s for s in part if s not in ok]
        row = dict(states=len(part), stuck=len(bad))
        if bad:
            row["shortest"] = min((path_to(prev, s) for s in bad), key=len)
        rows[name] = row
    out = dict(states=len(obs), actions=acts, checks=rows)
    for name, row in rows.items():
        print(f"{name}: {row['stuck']} stuck of {row['states']}")
        if row["stuck"]:
            print("   shortest way in:", " ".join(row["shortest"]))
    if len(sys.argv) > 2:
        json.dump(out, open(sys.argv[2], "w"), indent=1)
    print("stall: " + ("none" if not any(r["stuck"] for r in rows.values()) else "FOUND"))

main()
