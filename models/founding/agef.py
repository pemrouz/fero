#!/usr/bin/env python3
"""The "always can finish" check, on a state graph TLC wrote.

Reads the dot file TLC dumps for a <Model>Live module, where every state
carries a tag: <<goal, judged, how the step into it was made>>.  It then
checks: from every judged state, calm steps alone can reach a goal state.
(The study calls this AG EF.)  A judged state that cannot is printed.

Usage: agef.py graph.dot      exit 0 when every judged state can finish
"""
import re, sys

NODE = re.compile(r'^(-?\d+) \[label="(.*?)",(?:style|tooltip)')
EDGE = re.compile(r'^(-?\d+) -> (-?\d+) ')
TAG = re.compile(r'tag = <<(TRUE|FALSE), (TRUE|FALSE), \\"(\w+)\\">>')

def check(path):
    goal, judged, calm, label = set(), set(), set(), {}
    back = {}                      # target -> the states with a step into it
    for line in open(path, errors="replace"):
        m = EDGE.match(line)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a != b:
                back.setdefault(b, []).append(a)
            continue
        m = NODE.match(line)
        if m:
            n = int(m.group(1))
            t = TAG.search(m.group(2))
            if not t:
                raise SystemExit("a state has no tag: is this a Live module's graph?")
            if t.group(1) == "TRUE": goal.add(n)
            if t.group(2) == "TRUE": judged.add(n)
            if t.group(3) == "calm": calm.add(n)
            label[n] = m.group(2)
    # Walk back from the goals over calm steps (a step is calm when the state
    # it leads INTO is tagged calm).
    can = set(goal)
    todo = list(goal)
    while todo:
        b = todo.pop()
        if b not in calm:
            continue
        for a in back.get(b, ()):
            if a not in can:
                can.add(a); todo.append(a)
    bad = [n for n in judged if n not in can]
    return len(label), len(judged), len(goal), bad, label

if __name__ == "__main__":
    states, judged, goals, bad, label = check(sys.argv[1])
    print(f"live: {states} states, {judged} judged, {goals} goals, {len(bad)} cannot finish")
    if bad:
        print("one judged state that cannot finish:")
        print(label[bad[0]].replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\"))
        sys.exit(1)
